/**
 * Which unmapped files nothing in the repository names, so the fail-open
 * comment can offer them for `ignore` instead of leaving the reader to grep.
 *
 * An unmapped file fails the whole selection open, and that stays true here:
 * this module only annotates. It never skips a file, never changes a verdict,
 * and a suggestion is a pattern the reader has to paste themselves.
 *
 * "Named" is deliberately generous, because a wrong "unnamed" is the only
 * harmful error -- it invites someone to ignore a file that feeds tests:
 *
 *   - the file's basename, or the name of ANY directory above it, appears as
 *     plain text anywhere outside Markdown and outside the file itself. Folders
 *     count because loaders walk them (`Files.list(migrations)`,
 *     a `fixtures` glob, `WalkDir("testdata")`) without naming
 *     any one file inside, however deep;
 *   - case is ignored, substrings count (`tokens.css` inside `theme-tokens.css`),
 *     and so do comments and log text. All three only suppress a suggestion.
 *
 * Some files affect tests without anything naming them: a framework loads them
 * by convention, or they define the toolchain every test runs on. Those are
 * never suggested, whatever the search finds. The list comes from real
 * fail-open PRs (one repository reverted a lockfile ignore for exactly this reason,
 * and bunfig.toml carries a [test] section).
 */

/**
 * Lockfiles. They change what every test runs against, and they never read a
 * repository file, however many paths they record.
 */
const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|pubspec\.lock|Package\.resolved|Podfile\.lock|Cartfile\.resolved|packages\.lock\.json|poetry\.lock|uv\.lock|Pipfile\.lock)$/;

/** True for a dependency lockfile. */
export function isLockfile(path: string): boolean {
  return LOCKFILE.test(path);
}

/**
 * Files something loads without naming them, so no search for a name can find
 * their readers. Shared with `references.ts`, which never resolves these.
 */
const LOADED_BY_CONVENTION: RegExp[] = [
  // Spring loads these by profile, by name or by location; no code spells the filename.
  /(^|\/)application[^/]*\.(ya?ml|properties)$/,
  /(^|\/)bootstrap[^/]*\.(ya?ml|properties)$/,
  /(^|\/)(logback|log4j2?)[^/]*\.(xml|properties|ya?ml)$/,
  /(^|\/)messages[^/]*\.properties$/,
  /(^|\/)META-INF\//,
  /(^|\/)resources\/(templates|static|public|graphql|db\/migration|db\/changelog)\//,
  /(^|\/)resources\/(schema|data)[^/]*\.sql$/,
  // Build-tool and shell settings read by location: `-Dspring.profiles.active` in
  // .mvn/maven.config, exports in a direnv .envrc.
  /(^|\/)\.mvn\//,
  /(^|\/)\.envrc$/,
  // Test-runner hooks read from the classpath by fixed name.
  /(^|\/)junit-platform\.properties$/,
  /(^|\/)mockito-extensions\//,
  // Read by test runners next to the test that owns them.
  /(^|\/)__snapshots__\//,
  /\.(snap|golden)$/,
  // Dependency manifests and lockfiles: they change what every test runs against.
  /(^|\/)package\.json$/,
  LOCKFILE,
  /(^|\/)(pnpm-workspace\.yaml|\.yarnrc(\.yml)?|\.npmrc)$/,
  /(^|\/)(Cargo\.toml|go\.(mod|work)|Gemfile|composer\.json)$/,
  /(^|\/)(pubspec\.yaml|Package\.swift|Podfile|Cartfile|Directory\.(Build|Packages)\.(props|targets))$/,
  /\.(csproj|fsproj|vbproj|sln|gemspec)$/,
  /(^|\/)(pyproject\.toml|Pipfile|requirements[^/]*\.txt|setup\.(py|cfg))$/,
  /(^|\/)(build|settings)\.gradle(\.kts)?$/,
  /(^|\/)(gradle\.properties|gradlew(\.bat)?|pom\.xml)$/,
  /(^|\/)gradle\/(wrapper\/|libs\.versions\.toml$)/,
  // Toolchain and test-runner configuration.
  /(^|\/)(bunfig\.toml|tsconfig[^/]*\.json|jsconfig[^/]*\.json|pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|\.coveragerc|\.nvmrc|\.node-version|\.tool-versions|\.python-version|\.ruby-version|\.rspec|\.swcrc)$/,
  /(^|\/)(\.babelrc|\.mocharc|\.nycrc|\.c8rc)[^/]*$/,
  /(^|\/)(jest|vitest|vite|babel|playwright|karma|mocha|cypress|webpack|rollup|esbuild|swc|next|nuxt|svelte|astro)\.(config|conf)\.[^/]+$/,
  /(^|\/)(jest|vitest)\.setup\.[^/]+$/,
  /(^|\/)(phpunit|phpunit\.dist)\.xml(\.dist)?$/,
  /(^|\/)(rust-toolchain(\.toml)?|build\.rs)$/,
  /(^|\/)\.cargo\//,
  /(^|\/)(Makefile|GNUmakefile|makefile|Justfile|justfile|Taskfile\.ya?ml|Rakefile)$/,
  // Loaded by dotenv conventions; only the documented templates are inert.
  /(^|\/)\.env(?!\.(example|sample|template)$)[^/]*$/,
];

/**
 * Also never offered for `ignore`, though a reader that names them can be found:
 * anything a JVM build puts on the classpath, and folders of cases a test walks.
 */
const NEVER_SUGGESTED: RegExp[] = [
  ...LOADED_BY_CONVENTION,
  /(^|\/)src\/[^/]+\/resources\//,
  /(^|\/)(snapshots|testdata|test-data|fixtures?|__fixtures__|golden)\//,
];

/** True when something loads the file by convention, without naming it anywhere. */
export function loadedByConvention(path: string): boolean {
  return LOADED_BY_CONVENTION.some((r) => r.test(path));
}

/** True when a file must never be offered for `ignore`, however unnamed it is. */
export function neverSuggested(path: string): boolean {
  return NEVER_SUGGESTED.some((r) => r.test(path));
}

/** The names that count as a reference to `path`, lowercased: its basename and every directory above it. */
function namesOf(path: string): string[] {
  return path.toLowerCase().split("/").filter((part) => part.length > 0);
}

/**
 * The subset of `paths` that nothing names and that is not on the never-list.
 *
 * `git` runs git in the repository. `rev` is the tree to search (the range's
 * head); without one the working tree is searched, untracked files included,
 * because an MCP caller's diff may describe files not yet committed.
 */
export function unnamedFiles(
  git: (...args: string[]) => string,
  rev: string | undefined,
  paths: string[],
): Set<string> {
  const candidates = [...new Set(paths)].filter((p) => !neverSuggested(p));
  if (candidates.length === 0) return new Set();
  const names = [...new Set(candidates.flatMap(namesOf))];

  // Whole lines, not `-o`: with `-o` a match of one name can swallow another it
  // contains, and a hidden match would read as "unnamed".
  const args = ["grep", "-I", "-F", "-i", "-z", "--no-color"];
  if (rev === undefined) args.push("--untracked");
  for (const name of names) args.push("-e", name);
  if (rev !== undefined) args.push(rev);
  args.push("--", ".", ":!*.md", ":!*.mdx");

  let out: string;
  try {
    out = git(...args);
  } catch (e) {
    // git grep exits 1 when nothing matches: every candidate is unnamed. Any
    // other failure propagates -- a search that did not run proves nothing.
    if ((e as { status?: number }).status === 1) out = "";
    else throw e;
  }

  // Each hit is `[<rev>:]<path>\0<line>`; one line can name several files.
  const prefix = rev !== undefined ? `${rev}:` : "";
  const filesNaming = new Map<string, Set<string>>();
  for (const hit of out.split("\n")) {
    const nul = hit.indexOf("\0");
    if (nul < 0) continue;
    const file = hit.slice(prefix.length, nul);
    const text = hit.slice(nul + 1).toLowerCase();
    for (const name of names) {
      if (!text.includes(name)) continue;
      let files = filesNaming.get(name);
      if (files === undefined) filesNaming.set(name, (files = new Set()));
      files.add(file);
    }
  }

  const unnamed = new Set<string>();
  for (const path of candidates) {
    const named = namesOf(path).some((name) =>
      [...(filesNaming.get(name) ?? [])].some((file) => file !== path),
    );
    if (!named) unnamed.add(path);
  }
  return unnamed;
}

/** An anchored regex matching exactly `path`, ready for the `ignore` input. */
export function ignorePatternFor(path: string): string {
  return `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}
