import type { CodeGraph, GraphNode } from "./graph.js";
import { nodesForPath } from "./graph.js";
import type { ChangedFile, FailOpenReason } from "./types.js";

export interface MappingResult {
  /** node ids seeding the impact walk */
  seeds: Set<string>;
  failOpen: FailOpenReason[];
}

function spanSize(n: GraphNode): number {
  return n.source_location!.end_line - n.source_location!.start_line;
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

    const headNodes = file.status === "deleted" ? [] : nodesForPath(graph, file.path);
    const baseNodes = opts.baseGraph ? nodesForPath(opts.baseGraph, file.oldPath) : [];

    if (headNodes.length === 0 && file.status !== "deleted") {
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
