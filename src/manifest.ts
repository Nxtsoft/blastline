import { isComment } from "./references.js";
import { isLockfile } from "./unnamed.js";

/**
 * Recognize a `package.json` change that cannot affect a test except through
 * code the graph knows: one that only adds npm scripts.
 *
 * A manifest has no graph node, so any diff touching one fails the whole
 * selection open (`unmapped-file`). That is right in general -- a dependency,
 * an engine, the `test` script or a test-runner key changes what every test
 * runs against -- but it makes selection blind on every PR that wires a new
 * tool in with `"docs:check": "bun run scripts/docs.ts check"`.
 *
 * The narrow cases this closes, like `cmake.ts` does for test registration: a
 * change that leaves the parsed manifest identical (formatting, key order),
 * and one where every key outside `"scripts"` is identical at base and head,
 * every script that existed is unchanged, and each added script is invoked by
 * nothing opaque:
 *
 *   - it is not a lifecycle or platform hook npm, bun, yarn or a host runs by
 *     name (`pretest`, `postinstall`, `prepare`, `test`, `build`, ...);
 *   - no non-code file names it (a CI workflow, a Makefile, a husky hook,
 *     turbo.json, an existing script), outside Markdown and outside the
 *     manifest's own new declarations -- and none names a pattern it falls
 *     under: its first segment with a wildcard, anchor or open string
 *     (`run-s "test:*"`, `/^test:/`, `"test:" + kind`), its last with a
 *     leading wildcard (`*:e2e`), or a pattern runner command with any `*`;
 *   - a code line that names it (a helper spawning `bun run docs:check`, or a
 *     usage message) is returned as a reader, so the tests that depend on it
 *     are selected. A comment that names it is not a reader.
 *
 * Everything else still fails open, and so does anything this cannot parse.
 */

/** Tools that run every script matching a pattern; searched as fixed strings, then checked as commands. */
const PATTERN_RUNNERS = ["run-s", "run-p", "npm-run-all", "turbo", "nx", "lerna", "wireit", "concurrently", "pnpm", "yarn"];

/**
 * One of PATTERN_RUNNERS as a command (`turbo run`, `npx nx@latest run-many`,
 * `node_modules/.bin/run-p`), not inside another word (`bunx`, `yarn-debug.log`).
 */
const RUNNER_COMMAND = new RegExp(`(^|[\\s"'\`(;&|/])(${PATTERN_RUNNERS.join("|")})(@\\S*)?(\\s|$)`);

/** The segments of a script name, split where pattern runners split it: `web`, `e2e` in `web:e2e`. */
function segmentsOf(name: string): string[] {
  return name.split(/[:\-_]/).filter((seg) => seg.length > 0);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A line that may run this new script without naming it. Pattern runners pick
 * scripts by their first segment (`test:*`, `test*`, `/^test:/`,
 * `` `test:${kind}` ``, `"test:" + kind`) or their last (`*:e2e`), with the
 * separators script names use (`:`, `-`, `_`); a pattern runner command with
 * any wildcard counts too. A path such as `/shared-docs/${id}` is not a
 * script pattern: `/` and `.` are not script separators.
 */
function matchesByPattern(text: string, name: string): boolean {
  const segs = segmentsOf(name);
  const first = escape(segs[0] ?? name);
  const last = escape(segs[segs.length - 1] ?? name);
  const edge = "(^|[^A-Za-z0-9_])";
  const after = "(?![A-Za-z0-9_])";
  if (new RegExp(`${edge}${first}[:\\-_]?(\\*|\\.\\*|\\{|\\$\\{)`).test(text)) return true; // test:*  test*  test:${
  if (new RegExp(`\\^${first}${after}`).test(text)) return true; // /^test:/
  if (new RegExp(`${edge}${first}[:\\-_]["'\`]`).test(text)) return true; // "test:" + kind
  if (segs.length > 1 && new RegExp(`\\*[:\\-_]?${last}${after}`).test(text)) return true; // *:e2e
  return text.includes("*") && RUNNER_COMMAND.test(text);
}

/** Package managers: their first argument (after `run`) is a script name, or a file they run. */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/** Tools whose arguments are script names or patterns over them. */
const SCRIPT_TOOLS = ["run-s", "run-p", "run-z", "npm-run-all", "turbo", "nx", "lerna", "wireit", "concurrently"];

const COMMAND_START = `(^|[\\s"'\`(;&|/])`;

/** A package manager and the argument in its script-name position (`npm run X`, `yarn X`), past any flags. */
const PM_SCRIPT_ARG = new RegExp(
  `${COMMAND_START}(${PACKAGE_MANAGERS.join("|")})(@\\S*)?\\s+(?:(?:run|run-script)\\s+)?(?:-{1,2}[\\w-]+(?:=\\S+)?\\s+)*(\\S+)`,
  "g",
);

/** A script tool as a command, by path or with a version. */
const RUNS_SCRIPT_TOOL = new RegExp(`${COMMAND_START}(${SCRIPT_TOOLS.join("|")})(@\\S*)?(\\s|$)`);

/**
 * A script run whose name is decided at run time: `npm run "$s"`,
 * `npm run ${{ matrix.app }}:e2e`, `pnpm run "/:e2e$/"`, or a script tool
 * given any expansion. Whatever it picks, no search for a new name can rule it
 * out. `bun run scripts/x.ts --base "$SHA"` runs a file with an argument, and
 * is not one.
 */
function runsDynamically(text: string): boolean {
  for (const m of text.matchAll(PM_SCRIPT_ARG)) {
    const arg = (m[4] ?? "").replace(/^["'`]|["'`]$/g, "");
    const isFile = !arg.startsWith("/") && (arg.includes("/") || /\.(m?[jt]sx?|c[jt]s)$/.test(arg));
    if (!isFile && (arg.includes("$") || /^\/.+\/$/.test(arg))) return true;
  }
  return RUNS_SCRIPT_TOOL.test(text) && text.includes("$");
}

/** A line that enumerates a manifest's scripts (`.scripts | keys`, `Object.keys(pkg.scripts)`), to run or filter them. */
function listsScripts(text: string): boolean {
  return /\.scripts\b|\[\s*["']scripts["']\s*\]|\bscripts\s*\|\s*(keys|to_entries)|\bnpm\s+run\s*(-l|--list)?\s*$/.test(text);
}

/** Needles that find the lines `runsDynamically` and `listsScripts` judge. */
const DYNAMIC_NEEDLES = [...PACKAGE_MANAGERS, ...SCRIPT_TOOLS, "scripts"];

/**
 * Files nothing ever runs from, however they spell a pattern: git's own files,
 * editor and review-bot settings, licences, lockfiles. Skipped for pattern
 * matches only -- a literal mention anywhere still counts, and CI helpers under
 * `.github/` or a pre-commit config do run commands.
 */
const NEVER_RUNS_ANYTHING = /(^|\/)(\.gitignore|\.gitattributes|\.mailmap|\.editorconfig|CODEOWNERS|LICENSE[^/]*|\.coderabbit\.ya?ml)$/;

/** Script names a package manager or host runs without being asked by name. */
const RUN_BY_CONVENTION =
  /^(pre|post)|^(install|prepare|prepublish|prepublishOnly|prepack|postpack|publish|dependencies|test|start|stop|restart|version|build|dev|serve|vercel-build|now-build|gcp-build|heroku-.+|netlify-.+|cf-build)$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structural equality, key ORDER included: Node resolves `exports` conditions
 * and Jest applies `moduleNameMapper` entries in the order they are written.
 */
function same(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parse(text: string): { [key: string]: Json } | null {
  try {
    const v = JSON.parse(text) as Json;
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The scripts `head` adds to `base` when that is ALL that changed, or null.
 * Null covers a parse failure, any other key changed, a script edited or
 * removed, and a `scripts` value that is not an object of strings.
 */
export function addedScriptsOnly(base: string, head: string): Map<string, string> | null {
  const before = parse(base);
  const after = parse(head);
  if (before === null || after === null) return null;
  const { scripts: oldScripts, ...oldRest } = before;
  const { scripts: newScripts, ...newRest } = after;
  if (!same(oldRest, newRest)) return null;
  const was = oldScripts ?? {};
  const now = newScripts ?? {};
  if (!isObject(was) || !isObject(now)) return null;
  for (const [name, command] of Object.entries(was)) {
    if (!Object.hasOwn(now, name) || now[name] !== command) return null;
  }
  // The scripts that existed keep their order: a pattern runner runs them in it.
  const kept = Object.keys(now).filter((name) => Object.hasOwn(was, name));
  if (kept.join("\0") !== Object.keys(was).join("\0")) return null;
  const added = new Map<string, string>();
  for (const name of Object.keys(now).sort()) {
    if (Object.hasOwn(was, name)) continue;
    const command = now[name];
    if (typeof command !== "string") return null;
    added.set(name, command);
  }
  return added.size > 0 ? added : null;
}

/** A line outside Markdown that names one of the new scripts. */
export interface Mention {
  file: string;
  line: number;
  text: string;
}

/** Why a manifest change cannot affect a test except through `readers`, the code lines that name its new scripts. */
export interface ScriptAddition {
  why: string;
  readers: { file: string; line: number }[];
}

/**
 * The proof a manifest change affects tests only through code the graph knows,
 * or null when it may affect them some other way. `mentions(names)` returns,
 * for each name, the lines that name it outside Markdown, the manifest itself
 * included; `isCode(file)` says whether the graph has nodes for a file.
 */
export function inertScriptAddition(
  path: string,
  base: string,
  head: string,
  mentions: (names: string[]) => Map<string, Mention[]>,
  isCode: (file: string) => boolean,
): ScriptAddition | null {
  const before = parse(base);
  const after = parse(head);
  if (before !== null && after !== null && same(before, after)) return { why: "changes formatting only", readers: [] };
  const scripts = addedScriptsOnly(base, head);
  if (scripts === null) return null;
  const added = [...scripts.keys()];
  if (added.some((name) => RUN_BY_CONVENTION.test(name))) return null;
  // Patterns are matched on `:`, `-` and `_`; a name split some other way
  // (`test/e2e`, `test.e2e`) could fall under a pattern this cannot read.
  if (added.some((name) => !/^[A-Za-z0-9:_-]+$/.test(name))) return null;
  const segments = [...new Set(added.flatMap((n) => { const segs = segmentsOf(n); return [segs[0] ?? n, segs[segs.length - 1] ?? n]; }))];
  const hits = mentions([...new Set([...added, ...segments, ...PATTERN_RUNNERS, ...DYNAMIC_NEEDLES])]);
  const readers: { file: string; line: number }[] = [];
  // A run by a name decided at run time, or a listing of the scripts, may pick
  // up ANY new script: code doing it is walked, anything else fails open.
  const dynamic = new Map<string, Mention>();
  for (const needle of DYNAMIC_NEEDLES) {
    for (const hit of hits.get(needle) ?? []) {
      if (isComment(hit.text) || NEVER_RUNS_ANYTHING.test(hit.file) || isLockfile(hit.file)) continue;
      if (hit.file === path && declaresNewScript(hit.text, scripts)) continue;
      if (runsDynamically(hit.text) || listsScripts(hit.text)) dynamic.set(`${hit.file}\0${hit.line}`, hit);
    }
  }
  for (const hit of dynamic.values()) {
    if (hit.file !== path && isCode(hit.file)) readers.push({ file: hit.file, line: hit.line });
    else return null;
  }
  for (const name of added) {
    // Lines naming it, and lines whose pattern it falls under.
    const segs = segmentsOf(name);
    const byPattern = [segs[0] ?? name, segs[segs.length - 1] ?? name, ...PATTERN_RUNNERS]
      .flatMap((n) => hits.get(n) ?? [])
      .filter((h) => !NEVER_RUNS_ANYTHING.test(h.file) && !isLockfile(h.file) && matchesByPattern(h.text, name));
    const seen = new Set<string>();
    for (const hit of [...(hits.get(name) ?? []), ...byPattern]) {
      const key = `${hit.file}\0${hit.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A new script's own declaration line is not an invocation, and neither
      // is one new script calling another: nothing runs either of them.
      if (hit.file === path && declaresNewScript(hit.text, scripts)) continue;
      if (isComment(hit.text)) continue;
      // Code that names it may run it; the graph can say who depends on that.
      if (hit.file !== path && isCode(hit.file)) {
        readers.push({ file: hit.file, line: hit.line });
        continue;
      }
      return null; // an existing script, a workflow, a Makefile: opaque
    }
  }
  const through = readers.length > 0 ? `; code naming them is walked` : "";
  return { why: `only adds scripts${readers.length > 0 ? "" : " nothing runs"}: ${added.join(", ")}${through}`, readers };
}

/**
 * True when `text` is exactly the declaration of one of the new scripts: its
 * key and its command. A line with the same key elsewhere in the manifest (a
 * turbo pipeline entry, say) is config that runs it, and does not qualify.
 */
function declaresNewScript(text: string, scripts: Map<string, string>): boolean {
  let entry: Json;
  try {
    entry = JSON.parse(`{${text.trim().replace(/,$/, "")}}`) as Json;
  } catch {
    return false;
  }
  if (!isObject(entry)) return false;
  const keys = Object.keys(entry);
  return keys.length === 1 && scripts.get(keys[0] as string) === entry[keys[0] as string];
}
