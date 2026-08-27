import { declaredTests, isCMakePath } from "./cmake.js";
import { isTestPath } from "./detect.js";
import type { CodeGraph, GraphNode } from "./graph.js";
import { nodesInFile } from "./graph.js";
import type { ChangedFile, FailOpenReason } from "./types.js";

export interface MappingResult {
  /** node ids seeding the impact walk */
  seeds: Set<string>;
  failOpen: FailOpenReason[];
}

function spanSize(n: GraphNode): number {
  return n.source_location!.end_line - n.source_location!.start_line;
}

/** Directory part of a repo-relative path, "" at the repo root. */
function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut + 1);
}

/**
 * A build file the graph has no node for is normally a fail-open. When it is a
 * CMake file whose diff does nothing but register new test targets, it is not
 * opaque: it names the tests that appeared, and their sources seed the walk
 * like any other changed test file (issue #22).
 *
 * Returns null — meaning "fail open, as before" — unless EVERY declared source
 * is a recognized test path AND is present in the graph. A declared source the
 * graph has never seen cannot be selected, and silently seeding nothing would
 * turn a loud "run everything" into a quiet "run nothing".
 */
function registeredTestSeeds(graph: CodeGraph, file: ChangedFile): Set<string> | null {
  if (!isCMakePath(file.path)) return null;
  if (file.added === undefined || file.removed === undefined) return null;
  const tests = declaredTests(file.added, file.removed);
  if (tests === null) return null;

  const dir = dirOf(file.path);
  const seeds = new Set<string>();
  for (const test of tests) {
    const sources = test.sources.map((s) => `${dir}${s}`).filter(isTestPath);
    if (sources.length === 0) return null; // registered something that is not a test
    for (const source of sources) {
      const nodes = nodesInFile(graph, source);
      if (nodes.length === 0) return null; // declared but unextracted
      for (const n of nodes) seeds.add(n.id);
    }
  }
  return seeds;
}

/**
 * Map changed line ranges to seed nodes.
 *
 * Rule (corrected by the phase-1 spike): the seed set is the union over
 * changed LINES of the innermost non-file node containing that line — not one
 * winner per range. A whole-file addition therefore seeds every symbol in the
 * file. Lines outside any symbol span seed the file node.
 *
 * Deletions: pure-deletion ranges carry base-side line numbers. With a base
 * graph supplied they map against it; without one they degrade to the head
 * file node (its importers are a superset of the deleted symbol's importers in
 * module-scoped languages) — and to fail-open when the whole file is gone.
 */
export function mapDiffToSeeds(
  graph: CodeGraph,
  changed: ChangedFile[],
  opts: { baseGraph?: CodeGraph; ignore?: (path: string) => boolean } = {},
): MappingResult {
  const seeds = new Set<string>();
  const failOpen: FailOpenReason[] = [];

  for (const file of changed) {
    if (opts.ignore?.(file.path) && opts.ignore?.(file.oldPath)) continue;

    const headNodes = file.status === "deleted" ? [] : nodesInFile(graph, file.path);
    const baseNodes = opts.baseGraph ? nodesInFile(opts.baseGraph, file.oldPath) : [];

    if (headNodes.length === 0 && file.status !== "deleted") {
      const registered = registeredTestSeeds(graph, file);
      if (registered !== null) {
        for (const id of registered) seeds.add(id);
        continue;
      }
      failOpen.push({ kind: "unmapped-file", path: file.path });
      continue;
    }
    if (file.status === "deleted") {
      if (baseNodes.length === 0) {
        failOpen.push({ kind: "unmapped-file", path: file.oldPath });
        continue;
      }
      // Whole file gone: every base-side symbol (and the file itself) is a seed.
      for (const n of baseNodes) seeds.add(n.id);
      continue;
    }

    const fileNode = headNodes.find((n) => n.type === "file");
    const symbols = headNodes.filter((n) => n.type !== "file" && n.source_location);
    // A non-file node anchored to this file WITHOUT a span (a seam contract
    // node — a schema whose canonical file this is) is file-scoped: any change
    // to the file touches it. Seed it unconditionally.
    for (const n of headNodes) {
      if (n.type !== "file" && !n.source_location) seeds.add(n.id);
    }
    const baseSymbols = baseNodes.filter((n) => n.type !== "file" && n.source_location);
    const baseFileNode = baseNodes.find((n) => n.type === "file");

    for (const range of file.ranges) {
      if (range.deletion && !opts.baseGraph) {
        // Old-side line numbers cannot be resolved against head spans; the
        // file node is the documented superset-safe degradation.
        if (fileNode) seeds.add(fileNode.id);
        continue;
      }
      const pool = range.deletion ? baseSymbols : symbols;
      const fallback = range.deletion ? baseFileNode : fileNode;
      for (let line = range.start; line <= range.end; line++) {
        const containing = pool.filter(
          (n) => n.source_location!.start_line <= line && n.source_location!.end_line >= line,
        );
        if (containing.length > 0) {
          containing.sort((a, b) => spanSize(a) - spanSize(b));
          seeds.add((containing[0] as GraphNode).id);
        } else if (fallback) {
          seeds.add(fallback.id);
        }
      }
    }
  }
  return { seeds, failOpen };
}
