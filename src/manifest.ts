import { isComment } from "./references.js";

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
 *     manifest's own new declarations;
 *   - a code line that names it (a helper spawning `bun run docs:check`, or a
 *     usage message) is returned as a reader, so the tests that depend on it
 *     are selected. A comment that names it is not a reader.
 *
 * Everything else still fails open, and so does anything this cannot parse.
 */

/** Script names a package manager or host runs without being asked by name. */
const RUN_BY_CONVENTION =
  /^(pre|post)|^(install|prepare|prepublish|prepublishOnly|prepack|postpack|publish|dependencies|test|start|stop|restart|version|build|dev|serve|vercel-build|now-build|gcp-build|heroku-.+|netlify-.+|cf-build)$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality, key order ignored. */
function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => same(a[k], b[k]));
  }
  return false;
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
    if (now[name] !== command) return null;
  }
  const added = new Map<string, string>();
  for (const name of Object.keys(now).sort()) {
    if (name in was) continue;
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
  const hits = mentions(added);
  const readers: { file: string; line: number }[] = [];
  for (const name of added) {
    for (const hit of hits.get(name) ?? []) {
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
