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

const NEVER_SUGGESTED: RegExp[] = [
  // Spring loads these by profile or by name; no code spells the filename.
  /(^|\/)application[^/]*\.(ya?ml|properties)$/,
  /(^|\/)bootstrap[^/]*\.(ya?ml|properties)$/,
  /(^|\/)(logback|log4j2?)[^/]*\.(xml|properties|ya?ml)$/,
  /(^|\/)META-INF\//,
  /(^|\/)src\/[^/]+\/resources\//,
  // Read by test runners by convention, or walked as a folder of cases.
  /(^|\/)(__snapshots__|snapshots|testdata|test-data|fixtures?|__fixtures__|golden)\//,
  /\.(snap|golden)$/,
  // Dependency manifests and lockfiles: they change what every test runs against.
  /(^|\/)package\.json$/,
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc(\.yml)?|\.npmrc)$/,
  /(^|\/)(Cargo\.(toml|lock)|go\.(mod|sum|work)|Gemfile(\.lock)?|composer\.(json|lock))$/,
  /(^|\/)(pubspec\.(yaml|lock)|Package\.(swift|resolved)|Podfile(\.lock)?|Cartfile(\.resolved)?|packages\.lock\.json|Directory\.(Build|Packages)\.(props|targets))$/,
  /\.(csproj|fsproj|vbproj|sln|gemspec)$/,
  /(^|\/)(pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.(py|cfg))$/,
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
