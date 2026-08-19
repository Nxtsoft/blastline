import { statSync } from "node:fs";
import { testFiles } from "./detect.js";
import { parseUnifiedDiff } from "./diff.js";
import type { CodeGraph } from "./graph.js";
import { dependents } from "./impact.js";
import { mapDiffToSeeds } from "./mapping.js";
import type { FailOpenReason, Selection } from "./types.js";

export interface SelectOptions {
  graph: CodeGraph;
  baseGraph?: CodeGraph;
  /** repo-relative path predicate for files declared irrelevant by the user */
  ignore?: (path: string) => boolean;
  /** fail open when the diff touches more files than this (default 200) */
  maxFiles?: number;
  /**
   * Fail open when the graph averages fewer edges per file node than this
   * (default 3). Healthy TS extraction runs ~9-10 edges/file; the benchmark's
   * pathological case (es-toolkit, CGraph issues #39/#40) sits at ~1.9 — an
   * under-extracted graph must produce ALL, not a confidently tiny subset.
   */
  minDensity?: number;
  /** graph.json mtime (ms) and head-commit time (ms) for the staleness guard */
  graphMtimeMs?: number;
  headCommitMs?: number;
}

/** The full selection pipeline: diff text in, Selection out. Deterministic. */
export function select(diffText: string, opts: SelectOptions): Selection {
  const changed = parseUnifiedDiff(diffText);
  const reasons: FailOpenReason[] = [];

  const maxFiles = opts.maxFiles ?? 200;
  if (changed.length > maxFiles) {
    reasons.push({ kind: "diff-too-large", files: changed.length, limit: maxFiles });
  }
  const minDensity = opts.minDensity ?? 3;
  const fileNodeCount = opts.graph.nodes.filter((n) => n.type === "file").length;
  if (fileNodeCount > 0) {
    const edgesPerFile = opts.graph.links.length / fileNodeCount;
    if (edgesPerFile < minDensity) {
      reasons.push({
        kind: "sparse-graph",
        edgesPerFile: Math.round(edgesPerFile * 100) / 100,
        threshold: minDensity,
      });
    }
  }
  if (
    opts.graphMtimeMs !== undefined &&
    opts.headCommitMs !== undefined &&
    opts.graphMtimeMs < opts.headCommitMs
  ) {
    reasons.push({
      kind: "stale-graph",
      expected: `graph built after head commit (${new Date(opts.headCommitMs).toISOString()})`,
      actual: `graph.json mtime ${new Date(opts.graphMtimeMs).toISOString()}`,
    });
  }

  const ignore = opts.ignore;
  const mapping = mapDiffToSeeds(opts.graph, changed, {
    ...(opts.baseGraph !== undefined && { baseGraph: opts.baseGraph }),
    ...(ignore !== undefined && { ignore }),
  });
  reasons.push(...mapping.failOpen);

  if (reasons.length > 0) return { kind: "all", reasons };

  const blastIds = dependents(opts.graph, mapping.seeds);
  const testSet = testFiles(opts.graph);
  const blast: string[] = [];
  const tests = new Set<string>();
  for (const id of blastIds) {
    const node = opts.graph.byId.get(id);
    if (!node) continue;
    const loc = node.source_location ? `:${node.source_location.start_line}` : "";
    blast.push(`${node.type} ${node.label}${node.source_file ? ` (${node.source_file}${loc})` : ""}`);
    if (node.source_file && testSet.has(node.source_file)) tests.add(node.source_file);
  }
  // Seeds that are themselves inside test files select those tests too.
  for (const id of mapping.seeds) {
    const node = opts.graph.byId.get(id);
    if (node?.source_file && testSet.has(node.source_file)) tests.add(node.source_file);
  }
  return { kind: "subset", tests: [...tests].sort(), blast: blast.sort() };
}

export function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
