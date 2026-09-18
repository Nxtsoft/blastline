import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * cgraph's own verdict for each path under the project root, written beside
 * graph.json as paths.json.
 *
 * The distinction is the whole point, and the two halves are NOT
 * interchangeable:
 *
 *   ignored    cgraph deliberately skipped it -- a root .gitignore match or a
 *              dependency directory. The graph is COMPLETE without it, so the
 *              file contributes no uncertainty.
 *   unindexed  cgraph visited it and no extractor claimed it. The graph may be
 *              INCOMPLETE because of it. CMakeLists.txt, .sh, .cmake and .yaml
 *              land here, and each can change what a test means.
 *
 * Only `ignored` is safe to act on. Treating `unindexed` as irrelevant would
 * let a build file silently shrink the test set.
 */
export interface PathVerdicts {
  /** Repo-relative subtree roots whose contents cgraph never walked. */
  ignoredDirectories: string[];
  /** Repo-relative files matching the root .gitignore directly. */
  ignoredFiles: Set<string>;
  /** Repo-relative files visited but unextracted. NOT safe to skip. */
  unindexed: Set<string>;
}

/** Reads paths.json beside the given graph.json. Absent or malformed -> undefined. */
export function loadPathVerdicts(graphPath: string): PathVerdicts | undefined {
  const candidate = resolve(dirname(graphPath), "paths.json");
  if (!existsSync(candidate)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    // An unrecognized schema is treated as absent rather than guessed at: a
    // wrong verdict here removes tests from the run.
    if (raw["schema_version"] !== 1) return undefined;
    const list = (key: string): string[] =>
      Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
    return {
      ignoredDirectories: list("ignored_directories"),
      ignoredFiles: new Set(list("ignored_files")),
      unindexed: new Set(list("unindexed")),
    };
  } catch {
    return undefined;
  }
}

/**
 * True when cgraph deliberately skipped this path, so the graph is complete
 * without it. Deliberately does NOT consult `unindexed`.
 */
export function isDeliberatelyIgnored(verdicts: PathVerdicts, path: string): boolean {
  if (verdicts.ignoredFiles.has(path)) return true;
  // A subtree root stands for everything beneath it: cgraph never walked those
  // files, so they are never listed individually.
  return verdicts.ignoredDirectories.some((dir) => path === dir || path.startsWith(`${dir}/`));
}
