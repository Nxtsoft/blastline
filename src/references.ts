import { isLockfile, loadedByConvention } from "./unnamed.js";

/**
 * Who reads a changed file the graph has no node for.
 *
 * An unmapped file fails the whole selection open, because nothing in the graph
 * says what depends on it. For a data or config file that is often knowable
 * from the repository: a test that opens `fixtures/rows.csv` says so in a
 * string. When EVERY reader can be found, the file is not opaque -- its readers
 * seed the walk at the lines that name it, and the tests that depend on them
 * are selected instead of the full suite.
 *
 * "Every reader" is the whole difficulty, and each rule below exists to keep
 * the harmful error -- a reader missed, so a test that should run does not --
 * out. When in doubt the answer is `unresolved`, which is today's fail-open.
 *
 *   name     a non-comment line names the file's basename (case ignored).
 *   folder   a file names a folder above it as a path component AND enumerates
 *            a directory somewhere (readdir, glob, Files.list, WalkDir,
 *            classpath*:, `**` ...). A loader that walks `migrations` names no
 *            migration, and a file that merely imports from `lib/` walks nothing.
 *   spring   `application[-P].{yml,properties}` in a Spring repository is read
 *            by configuration, not by name. The base file is read by every test
 *            that starts an application context; a profile file by code that
 *            activates or templates profile P. Profile activation the repository
 *            makes outside code (a Spring config `profiles:` block, a build file,
 *            a CI workflow, test resources) cannot be traced to tests, so it
 *            leaves the file unresolved.
 *
 * A reader the graph has no node for is itself opaque. If it can shape a test
 * run (build, toolchain or test-runner config, Spring config, test resources,
 * a CI workflow) the file stays unresolved. Otherwise -- a compose file, a k8s
 * manifest, an alert rule -- it cannot make a test read anything by itself, so
 * its own readers are followed instead, a few levels deep. A file that no code
 * reads at all stays unresolved too: "nothing reads it" is `ignore`'s job, and
 * that is a decision for a person (see `unnamed.ts`).
 */

export type ReferenceRule = "name" | "folder" | "spring-profile" | "spring-context";

/** A file that reads the changed one, and the lines that say so. */
export interface Reader {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed lines, at the searched revision, that name or load the changed file. */
  lines: number[];
  rule: ReferenceRule;
}

export type Resolution =
  | { kind: "referenced"; readers: Reader[] }
  | { kind: "unresolved"; why: string };

export interface ResolveContext {
  /** True when the graph has at least one node for this repo-relative path. */
  hasNodes: (path: string) => boolean;
  /** True when the user or cgraph declared the path irrelevant to tests. */
  irrelevant: (path: string) => boolean;
  /** A repo-relative file's text at the searched revision (the working tree when there is none). */
  read: (path: string) => string;
}

/** One line of `git grep -n` output. */
interface Hit {
  file: string;
  line: number;
  text: string;
}

/** How many non-code readers deep a chain of names is followed. */
const MAX_DEPTH = 3;

// Only markers no code line starts with: a line opening with a quote is a
// list item (`'rows.csv',`), not a comment, and must stay a reader. Directives
// that look like comments load files, so they are not comments: C and
// Objective-C `#include`/`#import`/`#embed`, Go `//go:embed`, TypeScript
// `/// <reference path=...>`.
const COMMENT = /^\s*(#(?!\s*(include|import|embed)\b)|\/\/(?!go:embed\b|\/\s*<reference\b)|\/\*|\*|<!--|--(\s|$))/;

/** Fixed strings that pre-filter lines for WALK; the regex decides. */
const WALK_MARKERS = [
  "readdir", "opendir", "Files.", "listFiles", "listdir", "os.walk", "scandir", "glob", "Glob",
  "WalkDir", "filepath.Walk", "Dir.", "getResources", "classpath*:", "require.context",
  "rglob", "iterdir", "read_dir", "DirectoryStream", "walkFileTree", "**/",
];
const WALK =
  /readdir|opendir|Files\.(list|walk|find|newDirectoryStream)|listFiles|listdir|os\.walk|scandir|\bglob\b|globSync|\bGlob\b|WalkDir|filepath\.Walk|Dir\.(glob|children|entries|each_child)|getResources|classpath\*:|require\.context|import\.meta\.glob|rglob|iterdir|read_dir|DirectoryStream|walkFileTree|\*\*\//;

/** Ways code builds a profile file's name instead of spelling it. */
const PROFILE_TEMPLATES = ["application-$", "application-{", "application-%", '"application-" +', "'application-' +", "`application-${"];

/** Ways code or config activates a Spring profile. */
const ACTIVATION_MARKERS = [
  "ActiveProfiles", "spring.profiles", "SPRING_PROFILES", "setAdditionalProfiles",
  "addActiveProfile", "setActiveProfiles", ".profiles(",
];

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

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `name` as a whole path component: `migrations` in `db/migrations/x` or `"migrations"`, not in `migrationsLog`. */
function namesPathComponent(text: string, name: string): boolean {
  return new RegExp(`(^|[/"'\`\\s(,=:])${escapeRegex(name)}([/"'\`\\s),*]|$)`, "i").test(text);
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

/** Accumulates readers per file and rule; an `unresolved` short-circuits. */
class Readers {
  private readonly byFile = new Map<string, Reader>();

  add(file: string, line: number, rule: ReferenceRule): void {
    const key = `${file}\0${rule}`;
    const reader = this.byFile.get(key) ?? { file, lines: [], rule };
    if (!reader.lines.includes(line)) reader.lines.push(line);
    this.byFile.set(key, reader);
  }

  list(): Reader[] {
    return [...this.byFile.values()]
      .map((r) => ({ ...r, lines: [...r.lines].sort((a, b) => a - b) }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  }
}

class Unresolved extends Error {}

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

  /**
   * Route one reader of `path`: code joins the result; opaque config that can
   * shape a test run makes `path` unresolved; any other non-code file is looked
   * through to its own readers.
   */
  const route = (path: string, hit: Hit, rule: ReferenceRule, out: Readers, depth: number, seen: Set<string>): void => {
    // A lockfile records paths but never reads a repository file.
    if (hit.file === path || ctx.irrelevant(hit.file) || isLockfile(hit.file)) return;
    if (COMMENT.test(hit.text)) return;
    if (ctx.hasNodes(hit.file)) {
      out.add(hit.file, hit.line, rule);
      return;
    }
    if (shapesTestRuns(hit.file)) throw new Unresolved(`${hit.file} names it and can change how tests run`);
    if (seen.has(hit.file)) return;
    plain(hit.file, out, depth + 1, seen);
  };

  /** The `name` and `folder` rules for one file, feeding `out`. */
  const plain = (path: string, out: Readers, depth: number, seen: Set<string>): void => {
    if (depth > MAX_DEPTH) throw new Unresolved(`readers of readers go deeper than ${MAX_DEPTH} files`);
    seen.add(path);
    const name = basename(path);
    for (const hit of search.lines([name], { ignoreCase: true })) route(path, hit, "name", out, depth, seen);

    const folders = path.split("/").slice(0, -1);
    if (folders.length === 0) return;
    const naming = search
      .lines(folders, { ignoreCase: true })
      .filter((hit) => !COMMENT.test(hit.text) && folders.some((f) => namesPathComponent(hit.text, f)));
    const candidates = [...new Set(naming.map((h) => h.file))].filter((f) => f !== path && !ctx.irrelevant(f));
    const walkers = new Set(
      search
        .lines(WALK_MARKERS, { paths: candidates })
        .filter((hit) => !COMMENT.test(hit.text) && WALK.test(hit.text))
        .map((hit) => hit.file),
    );
    for (const hit of naming) if (walkers.has(hit.file)) route(path, hit, "folder", out, depth, seen);
  };

  /** The `spring` rules for `application[-profile].{yml,properties}`. */
  const springConfig = (path: string, profile: string | undefined, out: Readers): void => {
    const seen = new Set([path]);
    for (const hit of search.lines([basename(path)], { ignoreCase: true })) route(path, hit, "name", out, 1, seen);

    if (profile === undefined || profile === "default") {
      for (const hit of search.lines(CONTEXT_MARKERS)) {
        if (!COMMENT.test(hit.text) && ctx.hasNodes(hit.file) && !ctx.irrelevant(hit.file)) out.add(hit.file, hit.line, "spring-context");
      }
      return;
    }

    // Code that builds `application-<p>.yml` from a list of profile names.
    const templated = new Set(
      search.lines(PROFILE_TEMPLATES).filter((h) => !COMMENT.test(h.text)).map((h) => h.file),
    );
    for (const hit of search.lines([`"${profile}"`, `'${profile}'`], { paths: [...templated] })) {
      if (!COMMENT.test(hit.text) && ctx.hasNodes(hit.file) && !ctx.irrelevant(hit.file)) out.add(hit.file, hit.line, "spring-profile");
    }

    // Anything that activates the profile.
    for (const hit of search.lines(ACTIVATION_MARKERS)) {
      if (hit.file === path || ctx.irrelevant(hit.file) || COMMENT.test(hit.text)) continue;
      if (!namesWord(beforeHashComment(hit.text), profile)) continue;
      if (ctx.hasNodes(hit.file)) out.add(hit.file, hit.line, "spring-profile");
      else if (shapesTestRuns(hit.file)) throw new Unresolved(`${hit.file} activates profile ${profile}`);
    }
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
      if (ctx.irrelevant(config)) continue;
      if (activatesInYaml(ctx.read(config), profile)) throw new Unresolved(`${config} activates profile ${profile} in its profiles block`);
    }
  };

  const result = new Map<string, Resolution>();
  for (const path of paths) {
    const out = new Readers();
    try {
      const spec = SPRING_CONFIG.exec(path);
      if (spec !== null && isSpring()) springConfig(path, spec[3], out);
      else if (loadedByConvention(path)) throw new Unresolved("loaded by convention, not by name");
      else plain(path, out, 0, new Set());
      const readers = out.list();
      result.set(
        path,
        readers.length > 0 ? { kind: "referenced", readers } : { kind: "unresolved", why: "no code names it" },
      );
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
      result.set(path, { kind: "unresolved", why: e.message });
    }
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
