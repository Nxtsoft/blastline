import { isLockfile, loadedByConvention } from "./unnamed.js";

/**
 * Who reads a changed file the graph has no node for -- advice, never selection.
 *
 * An unmapped file fails the whole selection open, because nothing in the graph
 * says what depends on it. Its readers are often visible in the repository: a
 * test that opens `fixtures/rows.csv` says so in a string. The comment lists
 * them, and the tests they reach, under the full-suite verdict, so a reviewer
 * sees the short list that most likely covers the change.
 *
 * It stays advice because no search can prove it found EVERY reader: a path
 * built at runtime, a framework loading files by convention, config that
 * changes how every test runs. An earlier version let the list replace the
 * full suite; review showed it silently dropped real tests, and the version
 * strict enough to be safe vouched for no file in 30 real PRs. So selection
 * never changes here, and whatever the rules below cannot vouch for is said
 * plainly as a caveat.
 *
 * A reader counts when it:
 *
 *   name       names the file (`load("rows.csv")`, `#include "tables.h"`).
 *   path-part  mentions a piece a path to the file can be built from: its stem
 *              in quotes (`loadFixture("rows")`), its folder used as a path
 *              (`join(dir, "../fixtures")`, `ReadDir("testdata")`, `test/cli`,
 *              `migrations/*.cypher`), a higher folder in a file that walks
 *              directories, or a directory walk over its extension. A folder
 *              counts only where the path could continue to the file:
 *              `src/lib/x` is not a way to `src/db/x`.
 *   spring     for `application[-P].{yml,properties}` in a Spring repository:
 *              every test that starts an application context (the base file),
 *              or code that names, templates or activates profile P -- and in
 *              both cases every subclass of such a test class and every class
 *              annotated with such an annotation.
 *
 * Comments never count, except directives that load files (`#include`,
 * `//go:embed`, `/// <reference>`, Rust `#[...]` attributes). Lockfiles and
 * repository metadata only a hosted service reads (`.github/dependabot.yml`,
 * `CODEOWNERS`, `.gitignore`) are never readers.
 *
 * A reader without a graph node is opaque. If it can shape a test run (build,
 * toolchain, test-runner or Spring config, a CI workflow) that is a caveat;
 * otherwise -- a compose file, a k8s manifest -- the code that names IT is a
 * reader too, a few levels deep, and one nothing is found running is a caveat.
 */

export type ReferenceRule = "name" | "path-part" | "spring-profile" | "spring-context";

/** A file that reads the changed one, and the lines that say so. */
export interface Reader {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed lines, at the searched revision, that name or load the changed file. */
  lines: number[];
  rule: ReferenceRule;
}

/** The readers found for one file, and what the search could not vouch for. */
export interface Resolution {
  readers: Reader[];
  /** Why the list may be incomplete: opaque config that mentions it, profiles activated by expression, and so on. */
  caveats: string[];
}

export interface ResolveContext {
  /** True when the graph has at least one node for this repo-relative path. */
  hasNodes: (path: string) => boolean;
  /** A repo-relative file's text at the searched revision (the working tree when there is none). */
  read: (path: string) => string;
}

/** One line of `git grep -n` output. */
interface Hit {
  file: string;
  line: number;
  text: string;
}

/** How many non-code readers deep a chain of mentions is followed. */
const MAX_DEPTH = 3;

/** Rounds of subclass and annotation expansion before giving up. */
const MAX_EXPANSION = 5;

// Only markers no code line starts with: a line opening with a quote is a
// list item (`'rows.csv',`), not a comment, and must stay a reader. Directives
// that look like comments load files, so they are not comments: C and
// Objective-C `#include`/`#import`/`#embed`, Rust `#[...]`/`#![...]`
// attributes, Go `//go:embed`, TypeScript `/// <reference path=...>`.
/** True for a line that is only a comment (directives that load files excluded). */
export function isComment(text: string): boolean {
  return COMMENT.test(text);
}

const COMMENT = /^\s*(#(?!\s*(include|import|embed)\b|!?\[)|\/\/(?!go:embed\b|\/\s*<reference\b)|\/\*|\*|<!--|--(\s|$))/;

/** A line that enumerates a directory or matches files by pattern. Case-insensitive: Go spells it `ReadDir`. */
const WALK =
  /readdir|opendir|files\.(list|walk|find|newdirectorystream)|listfiles|listdir|os\.walk|scandir|\bglob(?!al)|fast-?glob|tinyglobby|\bfg\(|walkdir|filepath\.walk|dir\.(glob|children|entries|each_child)|\bdir\[|getresources|classpath\*:|require\.context|import\.meta\.glob|rglob|iterdir|read_dir|directorystream|walkfiletree|\.walk\(|\.list\(|go:embed|#\[files|\*\*\/|\/\*\./i;

/** Ways code builds a profile file's name instead of spelling it. */
const PROFILE_TEMPLATES = ["application-$", "application-{", "application-%", '"application-" +', "'application-' +", "`application-${"];

/** Ways code or config activates a Spring profile. */
const ACTIVATION_MARKERS = [
  "ActiveProfiles", "spring.profiles", "SPRING_PROFILES", "setAdditionalProfiles",
  "addActiveProfile", "setActiveProfiles", ".profiles(",
];

/** Calls whose arguments ARE profile names; a non-literal argument there cannot be read. */
const ACTIVATION_CALL = /(ActiveProfiles|setAdditionalProfiles|addActiveProfile|setActiveProfiles|\.profiles)\s*\((.*)$/;

/** Tests that start an application context, and so read application.yml. */
const CONTEXT_MARKERS = [
  "@SpringBootTest", "@WebMvcTest", "@WebFluxTest", "@DataJpaTest", "@DataJdbcTest", "@DataMongoTest",
  "@DataNeo4jTest", "@DataRedisTest", "@DataR2dbcTest", "@DataCassandraTest", "@DataElasticsearchTest",
  "@DataLdapTest", "@JdbcTest", "@JooqTest", "@JsonTest", "@RestClientTest", "@GraphQlTest",
  "@WebServiceClientTest", "@ContextConfiguration", "@SpringJUnitConfig", "@SpringJUnitWebConfig",
  "SpringExtension", "SpringRunner", "SpringApplication",
];

const SPRING_CONFIG = /(^|\/)application(-([^/]+?))?\.(ya?ml|properties)$/;

/**
 * A reader without graph nodes that can change how tests run -- build, toolchain
 * and test-runner config, Spring config, a CI workflow -- and so cannot be
 * looked through. A fixture or data file naming another is not one: it is read,
 * it does not decide what runs.
 */
function shapesTestRuns(path: string): boolean {
  return loadedByConvention(path) || /^\.github\/workflows\//.test(path);
}

/**
 * Files only a hosted service or git itself reads -- review bots, dependency
 * bots, ownership, attributes, editor settings. No test process reads them, so
 * a mention in one is not a reader and is not followed. CI workflows and
 * composite actions DO run tests, and are not here.
 */
const REPOSITORY_METADATA =
  /^\.github\/(?!workflows\/|actions\/)|(^|\/)(\.coderabbit\.ya?ml|CODEOWNERS|\.gitattributes|\.gitignore|\.mailmap|\.editorconfig|renovate\.json5?|\.pre-commit-config\.yaml|LICENSE[^/]*)$/;

/** True for a file only a hosted service or git reads, or a lockfile: neither reads nor runs anything. */
export function neverRuns(path: string): boolean {
  return REPOSITORY_METADATA.test(path) || isLockfile(path);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The basename without its last extension: `rows` for `rows.csv`, `.env` for `.env`. */
function stemOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The last extension with its dot, or "" when there is none. */
function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const QUOTE = `"'\``;

/**
 * True when `text` mentions folder `parts[i]` of `path` in a way a path to the
 * file could continue from. The mention is followed segment by segment while it
 * agrees with the file's path: it leads when it reaches the file (a prefix of
 * its name counts: `rows` for `rows.json`), ends in a glob or template on the
 * way (`migrations/*`, `rows.${ext}`), or stops at one of the file's folders --
 * its own folder in quotes or as a bare path's tail (`"../fixtures"`,
 * `bats test/cli`), or a higher one when the file walks directories. It does
 * not lead the moment it turns off (`@/lib/upload-processing/types` is not a
 * way to `lib/upload-processing/testdata/x.csv`), and a higher folder named on
 * its own (`working-directory: ./api`) is a module, not a way to one file.
 * `walks` is asked only when that last rule needs it: it reads the file.
 */
function folderLeadsTo(text: string, parts: string[], i: number, walks: () => boolean): boolean {
  const lower = text.toLowerCase();
  const want = parts.map((p) => p.toLowerCase());
  const walkingLine = WALK.test(text);
  const re = new RegExp(`(^|[/${QUOTE}\\s(,=:\\[])${escapeRegex(want[i] as string)}(?=[/${QUOTE}\\s),;\\]]|$)`, "g");
  for (let m = re.exec(lower); m !== null; m = re.exec(lower)) {
    const before = m[1] ?? "";
    let at = m.index + m[0].length;
    let j = i; // the file's component the mention has reached
    let verdict: boolean | undefined;
    while (lower[at] === "/") {
      const segment = /^[^/"'`\s),;\]]*/.exec(lower.slice(at + 1))?.[0] ?? "";
      if (segment === "") {
        at += 1; // a trailing slash: the mention stops at want[j], as `"../fixtures/" + name`
        break;
      }
      const next = want[j + 1] as string;
      const last = j + 1 === want.length - 1;
      // An exact match first: app-router folders such as `(group)` contain template characters.
      if (segment === next) {
        if (last) verdict = true;
        j++;
        at += 1 + segment.length;
        if (last) break;
        continue;
      }
      if (segment.startsWith("**")) {
        verdict = true; // any depth
        break;
      }
      // The literal part before any query, glob or template: `rows` in
      // `rows?raw`, `rows.` in `rows.${ext}`, "" in `${kind}` or `*.csv`.
      const literal = /^[^?#*{$%<[]*/.exec(segment)?.[0] ?? "";
      const templated = literal.length < segment.length;
      if (templated && next.startsWith(literal)) {
        // A template stands for one component; the rest must still agree.
        if (last) verdict = true;
        j++;
        at += 1 + segment.length;
        if (last) break;
        continue;
      }
      verdict = last && next.startsWith(`${literal}.`); // `rows` for `rows.json`, else it turned off
      break;
    }
    if (verdict === true) return true;
    if (verdict === false) continue;
    // The mention stops at folder want[j]. It can count as a quoted folder, as
    // a bare path's tail (`test/cli`), or as a bare folder on a line that walks
    // (`//go:embed static`); a bare word such as `new` in `new Map()` never
    // can, so it is dropped before the file is read.
    const after = lower[at];
    const quoted = after !== undefined && QUOTE.includes(after);
    if (!quoted && before !== "/" && j === i && !walkingLine) continue;
    if (j !== want.length - 2 && !walkingLine && !walks()) continue;
    return true;
  }
  return false;
}

/** The stem as a quoted token or a path's last piece: `"rows"`, `'rows' +`, `/rows"`. */
function stemMentioned(text: string, stem: string): boolean {
  return new RegExp(`[/${QUOTE}]${escapeRegex(stem)}[${QUOTE}]`, "i").test(text);
}

/** `word` standing alone, as a profile name does in `"production"` or `production,staging`. */
function namesWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegex(word)}([^A-Za-z0-9_.-]|$)`).test(text);
}

/** Text before a trailing `#` comment, for YAML and properties lines. */
function beforeHashComment(text: string): string {
  const cut = text.indexOf(" #");
  return cut === -1 ? text : text.slice(0, cut);
}

/** String literals removed, so what is left of an argument list is code. */
function withoutStrings(text: string): string {
  return text.replace(/"(\\.|[^"\\])*"|'(\\.|[^'\\])*'|`(\\.|[^`\\])*`/g, '""');
}

const RULE_STRENGTH: Record<ReferenceRule, number> = { name: 0, "spring-profile": 1, "spring-context": 2, "path-part": 3 };

class Searcher {
  private readonly cache = new Map<string, Hit[]>();

  constructor(
    private readonly git: (...args: string[]) => string,
    private readonly rev: string | undefined,
  ) {}

  /** Non-Markdown lines containing any of `needles` (fixed strings), optionally only in `paths`. */
  lines(needles: string[], opts: { ignoreCase?: boolean; paths?: string[] } = {}): Hit[] {
    if (needles.length === 0 || opts.paths?.length === 0) return [];
    const key = JSON.stringify([needles, opts]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const args = ["grep", "-I", "-F", "-n", "-z", "--no-color"];
    if (opts.ignoreCase) args.push("-i");
    if (this.rev === undefined) args.push("--untracked");
    for (const needle of needles) args.push("-e", needle);
    if (this.rev !== undefined) args.push(this.rev);
    args.push("--", ...(opts.paths ?? ["."]), ":!*.md", ":!*.mdx");

    let out: string;
    try {
      out = this.git(...args);
    } catch (e) {
      // exit 1: no line matched. Anything else is a search that did not run,
      // and proves nothing -- the caller must not read it as "no readers".
      if ((e as { status?: number }).status === 1) out = "";
      else throw e;
    }
    // Each hit is `[<rev>:]<path>\0<line>\0<text>`.
    const prefix = this.rev !== undefined ? `${this.rev}:` : "";
    const hits: Hit[] = [];
    for (const raw of out.split("\n")) {
      const a = raw.indexOf("\0");
      const b = raw.indexOf("\0", a + 1);
      if (a < 0 || b < 0) continue;
      hits.push({ file: raw.slice(prefix.length, a), line: Number(raw.slice(a + 1, b)), text: raw.slice(b + 1) });
    }
    this.cache.set(key, hits);
    return hits;
  }
}

/** Accumulates readers per file and rule. */
class Readers {
  private readonly byFile = new Map<string, Reader>();

  add(file: string, line: number, rule: ReferenceRule): void {
    // A line that names the file also mentions its folder; say it once.
    if (rule === "path-part" && this.byFile.get(`${file}\0name`)?.lines.includes(line)) return;
    const key = `${file}\0${rule}`;
    const reader = this.byFile.get(key) ?? { file, lines: [], rule };
    if (!reader.lines.includes(line)) reader.lines.push(line);
    this.byFile.set(key, reader);
  }

  size(): number {
    return this.byFile.size;
  }

  files(): Set<string> {
    return new Set([...this.byFile.values()].map((r) => r.file));
  }

  /** Strongest evidence first: a file named outright before one whose path could be built. */
  list(): Reader[] {
    return [...this.byFile.values()]
      .map((r) => ({ ...r, lines: [...r.lines].sort((a, b) => a - b) }))
      .sort((a, b) => RULE_STRENGTH[a.rule] - RULE_STRENGTH[b.rule] || a.file.localeCompare(b.file));
  }
}

/**
 * Resolve each path's readers at `rev` (the working tree when undefined).
 * Paths are repo-relative files the graph has no node for.
 */
export function resolveReferences(
  git: (...args: string[]) => string,
  rev: string | undefined,
  paths: string[],
  ctx: ResolveContext,
): Map<string, Resolution> {
  const search = new Searcher(git, rev);
  let spring: boolean | undefined;
  const isSpring = (): boolean =>
    (spring ??= search.lines(["org.springframework"], { paths: ["*.kt", "*.java", "*.kts", "*.gradle", "pom.xml"] }).length > 0);

  /** Whether a file enumerates a directory on any line; a loader names the folder on one line and walks it on another. */
  const walkers = new Map<string, boolean>();
  const walksAnywhere = (file: string): boolean => {
    let walks = walkers.get(file);
    if (walks === undefined) {
      walks = ctx.read(file).split("\n").some((line) => !COMMENT.test(line) && WALK.test(line));
      walkers.set(file, walks);
    }
    return walks;
  };

  /**
   * Route one reader of `path`: code joins the result; opaque config that can
   * shape a test run makes `path` unresolved; any other non-code file is looked
   * through to its own readers.
   */
  const route = (path: string, hit: Hit, rule: ReferenceRule, out: Readers, chain: string[], seen: Set<string>, caveats: Set<string>): void => {
    // A lockfile records paths but never reads a repository file.
    if (hit.file === path || isLockfile(hit.file) || REPOSITORY_METADATA.test(hit.file) || COMMENT.test(hit.text)) return;
    if (ctx.hasNodes(hit.file)) {
      out.add(hit.file, hit.line, rule);
      return;
    }
    if (shapesTestRuns(hit.file)) {
      caveats.add(`${hit.file} mentions ${chain.length === 0 ? "it" : path} and can change how tests run`);
      return;
    }
    if (seen.has(hit.file)) return;
    const before = out.size();
    plain(hit.file, out, [...chain, hit.file], seen, caveats);
    if (out.size() === before) caveats.add(`${hit.file} mentions ${chain.length === 0 ? "it" : path}; nothing found runs it`);
  };

  /** The `name` and `path-part` rules for one file, feeding `out`. */
  const plain = (path: string, out: Readers, chain: string[], seen: Set<string>, caveats: Set<string>): void => {
    if (chain.length > MAX_DEPTH) {
      caveats.add(`readers of readers go deeper than ${MAX_DEPTH} files: ${chain.join(" <- ")}`);
      return;
    }
    seen.add(path);
    for (const hit of search.lines([basename(path)], { ignoreCase: true })) route(path, hit, "name", out, chain, seen, caveats);
    // Through a non-code reader only its exact name counts: the pieces of an
    // intermediate file's path match route strings and slugs, not loaders.
    if (chain.length > 0) return;

    const stem = stemOf(path);
    if (stem !== basename(path)) {
      for (const hit of search.lines([stem], { ignoreCase: true })) {
        if (stemMentioned(hit.text, stem)) route(path, hit, "path-part", out, chain, seen, caveats);
      }
    }
    const parts = path.split("/");
    const folders = parts.slice(0, -1);
    if (folders.length > 0) {
      for (const hit of search.lines(folders, { ignoreCase: true })) {
        if (folders.some((_, i) => folderLeadsTo(hit.text, parts, i, () => walksAnywhere(hit.file)))) route(path, hit, "path-part", out, chain, seen, caveats);
      }
    }
    const ext = extensionOf(path);
    if (ext !== "") {
      for (const hit of search.lines([`*${ext}`], { ignoreCase: true })) {
        if (WALK.test(hit.text) || /\*\*/.test(hit.text)) route(path, hit, "path-part", out, chain, seen, caveats);
      }
    }
  };

  /**
   * Add every subclass of a reader class and every class annotated with a
   * reader annotation, until nothing new appears. Class names come from file
   * names, the JVM convention; a file whose class cannot be named that way
   * still counts itself, and its subclasses are searched under that name too.
   */
  const expandClasses = (out: Readers, rule: ReferenceRule, caveats: Set<string>): void => {
    const done = new Set<string>();
    for (let round = 0; ; round++) {
      const pending = [...out.files()].filter((f) => !done.has(f) && /\.(java|kt|groovy|scala)$/.test(f));
      if (pending.length === 0) return;
      if (round >= MAX_EXPANSION) {
        caveats.add(`test classes inherit context settings deeper than ${MAX_EXPANSION} levels`);
        return;
      }
      const names = pending.map((f) => stemOf(f));
      for (const f of pending) done.add(f);
      for (const hit of search.lines(names)) {
        if (COMMENT.test(hit.text) || pending.includes(hit.file)) continue;
        const uses = names.some((n) =>
          new RegExp(`(\\bextends\\s+${escapeRegex(n)}\\b|:\\s*${escapeRegex(n)}\\s*[({,]|,\\s*${escapeRegex(n)}\\s*[({,]|@${escapeRegex(n)}\\b)`).test(hit.text),
        );
        if (!uses) continue;
        if (ctx.hasNodes(hit.file)) out.add(hit.file, hit.line, rule);
        else caveats.add(`${hit.file} extends a context test but has no graph node`);
      }
    }
  };

  /** The `spring` rules for `application[-profile].{yml,properties}`. */
  const springConfig = (path: string, profile: string | undefined, out: Readers, caveats: Set<string>): void => {
    const seen = new Set([path]);
    for (const hit of search.lines([basename(path)], { ignoreCase: true })) route(path, hit, "name", out, [], seen, caveats);

    if (profile === undefined || profile === "default") {
      for (const hit of search.lines(CONTEXT_MARKERS)) {
        if (COMMENT.test(hit.text)) continue;
        if (ctx.hasNodes(hit.file)) out.add(hit.file, hit.line, "spring-context");
        else caveats.add(`${hit.file} starts a Spring context but has no graph node`);
      }
      expandClasses(out, "spring-context", caveats);
      return;
    }

    // Code that builds `application-<p>.yml` from a list of profile names.
    const templated = new Set(
      search.lines(PROFILE_TEMPLATES).filter((h) => !COMMENT.test(h.text)).map((h) => h.file),
    );
    for (const hit of search.lines([`"${profile}"`, `'${profile}'`], { paths: [...templated] })) {
      if (!COMMENT.test(hit.text) && ctx.hasNodes(hit.file)) out.add(hit.file, hit.line, "spring-profile");
    }

    // Anything that activates the profile.
    const activating = new Readers();
    for (const hit of search.lines(ACTIVATION_MARKERS)) {
      if (hit.file === path || COMMENT.test(hit.text)) continue;
      const call = ACTIVATION_CALL.exec(hit.text);
      // `@ActiveProfiles(Profiles.PRODUCTION)`: the profile is a constant this search cannot read.
      if (call !== null && /[A-Za-z_]/.test(withoutStrings(call[2] ?? "").replace(/\b(value|profiles|inheritProfiles|resolver|true|false)\b/g, ""))) {
        caveats.add(`${hit.file} activates profiles through an expression, not a literal`);
        continue;
      }
      if (!namesWord(beforeHashComment(hit.text), profile)) continue;
      if (ctx.hasNodes(hit.file)) activating.add(hit.file, hit.line, "spring-profile");
      else if (shapesTestRuns(hit.file)) caveats.add(`${hit.file} activates profile ${profile}`);
      // A compose file, Dockerfile or env file: whatever runs it activates the
      // profile, so its readers are readers here.
      else plain(hit.file, out, [hit.file], seen, caveats);
    }
    expandClasses(activating, "spring-profile", caveats);
    for (const reader of activating.list()) for (const line of reader.lines) out.add(reader.file, line, reader.rule);

    // A YAML `profiles:` block spreads activation over nested keys
    // (`group: { staging: production }`) no single line can show.
    const configs = new Set(
      search
        .lines(["profiles"], { paths: ["*.yml", "*.yaml", "*.properties"] })
        .filter((h) => SPRING_CONFIG.test(h.file) || /(^|\/)bootstrap[^/]*\.(ya?ml|properties)$/.test(h.file))
        .map((h) => h.file),
    );
    configs.delete(path);
    for (const config of configs) {
      if (activatesInYaml(ctx.read(config), profile)) caveats.add(`${config} activates profile ${profile} in its profiles block`);
    }
  };

  const result = new Map<string, Resolution>();
  for (const path of paths) {
    const out = new Readers();
    const caveats = new Set<string>();
    const spec = SPRING_CONFIG.exec(path);
    // A manifest, lockfile or toolchain file affects every test; naming its readers would mislead.
    if (spec === null && loadedByConvention(path)) continue;
    if (spec !== null && isSpring()) springConfig(path, spec[3], out, caveats);
    else if (spec !== null) continue;
    else plain(path, out, [], new Set(), caveats);
    result.set(path, { readers: out.list(), caveats: [...caveats].sort() });
  }
  return result;
}

/**
 * True when a Spring config's `profiles` settings name `profile`: a
 * `spring.profiles.*=...` property, or any value inside a YAML `profiles:`
 * block (active, include, default, or a group of any name).
 */
function activatesInYaml(text: string, profile: string): boolean {
  let block = -1; // indentation of the open `profiles:` key, or -1
  for (const raw of text.split("\n")) {
    if (COMMENT.test(raw) || raw.trim() === "") continue;
    const line = beforeHashComment(raw);
    const indent = line.length - line.trimStart().length;
    if (block >= 0 && indent <= block) block = -1;
    if (/^\s*spring\.profiles\.[\w.-]+\s*[=:]/.test(line) && namesWord(line, profile)) return true;
    if (/^\s*profiles\s*:/.test(line)) {
      block = indent;
      if (namesWord(line.replace(/^\s*profiles\s*:/, ""), profile)) return true;
      continue;
    }
    if (block >= 0 && namesWord(line, profile)) return true;
  }
  return false;
}
