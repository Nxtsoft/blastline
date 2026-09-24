import { statSync } from "node:fs";
import { testFiles, testReachability } from "./detect.js";
import { parseUnifiedDiff } from "./diff.js";
import type { CodeGraph } from "./graph.js";
import { dependencyDirection, translatePath } from "./graph.js";
import { TraversalExhausted, dependents } from "./impact.js";
import { mapDiffToSeeds } from "./mapping.js";
import { isDeliberatelyIgnored } from "./paths.js";
import type { PathVerdicts } from "./paths.js";
import type { ChangedFileImpact, FailOpenReason, FileEdge, Selection } from "./types.js";

export interface SelectOptions {
  graph: CodeGraph;
  baseGraph?: CodeGraph;
  /** repo-relative path predicate for files declared irrelevant by the user */
  ignore?: (path: string) => boolean;
  /**
   * cgraph's own verdict per path, from paths.json beside graph.json. Unlike
   * `ignore` -- a user DECLARATION that a path is irrelevant -- an `ignored`
   * verdict here is EVIDENCE: cgraph skipped the file via the root .gitignore
   * or a dependency directory, so the graph is complete without it and the file
   * contributes no uncertainty. That is what makes it sound to drop such files
   * before the size guard, which `ignore` alone would not justify.
   *
   * `unindexed` is never consulted for skipping: cgraph visited those files and
   * no extractor claimed them, so the graph may be incomplete because of them.
   */
  pathVerdicts?: PathVerdicts;
  /**
   * Fail open when the diff touches more files than this. **Unbounded by
   * default.** File count was never a safety property: selection is the union
   * over changed files of dependents(seeds(file)) ∩ tests, each term is a sound
   * superset, and a union of sound supersets is sound -- count does not enter
   * that argument. The guards that do measure uncertainty (`unmapped-file`,
   * `sparse-graph`, `disconnected-tests`, `no-test-files`) still fire per case.
   * What the count incidentally bounded was traversal COST, which
   * `maxTraversalNodes` now bounds directly. Retained as an opt-in.
   */
  maxFiles?: number;
  /**
   * Fail open when the selected tests reach this fraction of the whole suite
   * (default 0.9). Not a safety guard -- it can only turn a subset into ALL,
   * never the reverse. It is honesty: listing 95% of the suite as "impacted"
   * is worse than saying run everything, and it hides that selection bought
   * nothing.
   */
  maxSelectedFraction?: number;
  /**
   * Smallest suite the saturation check applies to (default 20). Below it the
   * ratio is noise -- selecting 2 of 2 tests is not evidence that selection
   * bought nothing -- and running a tiny suite is cheap regardless.
   */
  minSuiteForSaturation?: number;
  /**
   * Abandon selection when the dependency walk visits more than this many nodes
   * (default 2,000,000). Exhaustion returns ALL, never a partially traversed
   * subset -- a truncated walk is indistinguishable from a complete one, so
   * emitting it would silently drop tests.
   */
  maxTraversalNodes?: number;
  /**
   * Fail open when the graph averages fewer edges per file node than this
   * (default 3). Healthy TS extraction runs ~9-10 edges/file; the benchmark's
   * pathological case (es-toolkit, CGraph issues #39/#40) sits at ~1.9 — an
   * under-extracted graph must produce ALL, not a confidently tiny subset.
   */
  minDensity?: number;
  /**
   * Fail open when tests can forward-reach less than this fraction of the
   * repo's non-test symbols (default 0.25). Catches graphs that pass the
   * density floor but are blind for selection — no resolved edges from tests
   * into the implementation (measured: broken extraction sits at 0.07-0.11,
   * healthy graphs at 0.52-1.00).
   */
  minTestReachability?: number;
  /**
   * Pin the selection to this sha256-merkle-v1 content root. The graph must
   * carry a matching root or the selection fails open as stale — the
   * cryptographic upgrade over the mtime heuristic. Supplied directly
   * (--expect-root) or from a live daemon (--daemon-verify).
   */
  expectedContentRoot?: string;
  /** graph.json mtime (ms) and head-commit time (ms) for the staleness guard */
  graphMtimeMs?: number;
  headCommitMs?: number;
}

/** The full selection pipeline: diff text in, Selection out. Deterministic. */
export function select(diffText: string, opts: SelectOptions): Selection {
  const parsed = parseUnifiedDiff(diffText);
  const reasons: FailOpenReason[] = [];

  // Files cgraph deliberately skipped are removed from the diff before any
  // guard runs. The size guard counts files whose effect on the graph is
  // unknown; a file cgraph ignored by rule has a KNOWN effect -- none -- so
  // counting it overstates the uncertainty. This is the half that a user
  // `--ignore` rule could not deliver: the guard reads `changed.length`
  // before mapping applies `ignore`, so an ignore rule never rescued a large
  // diff. Both endpoints of a rename must be ignored, matching mapping.ts.
  const verdicts = opts.pathVerdicts;
  const changed =
    verdicts === undefined
      ? parsed
      : parsed.filter(
          (f) =>
            !(
              isDeliberatelyIgnored(verdicts, f.path) &&
              (f.oldPath === undefined || isDeliberatelyIgnored(verdicts, f.oldPath))
            ),
        );

  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
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
  if (opts.expectedContentRoot !== undefined) {
    const actual = opts.graph.contentRoot?.sha256;
    if (actual !== opts.expectedContentRoot) {
      reasons.push({
        kind: "stale-graph",
        expected: `content root ${opts.expectedContentRoot}`,
        actual: actual ? `content root ${actual}` : "graph carries no content root",
      });
    }
  }
  // A graph with no test-file nodes cannot answer "which tests does this change
  // affect", so it must not be allowed to answer "none". testReachability
  // returns null in exactly that case, and a null SKIPS the disconnected-tests
  // guard below rather than tripping it -- so without this check selection runs
  // to completion, intersects the blast radius against an empty test set, and
  // returns {kind:"subset", tests:[]}. The comment then renders that as "none --
  // no test file depends on the changed code": a confident answer built on an
  // empty graph. The disconnected-tests guard exists for this class of
  // blindness; this is its most extreme instance, not an exemption from it.
  const knownTests = testFiles(opts.graph);
  if (knownTests.size === 0) {
    reasons.push({ kind: "no-test-files" });
  }
  const minReach = opts.minTestReachability ?? 0.25;
  const coverage = testReachability(opts.graph);
  if (coverage !== null && coverage < minReach) {
    reasons.push({
      kind: "disconnected-tests",
      coverage: Math.round(coverage * 100) / 100,
      threshold: minReach,
    });
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

  // Deletion seeds are BASE-graph node ids: the deleted symbols no longer
  // exist at head, and the base graph is built from a different checkout, so
  // its ids never resolve in the head graph. Walk each seed in the graph that
  // owns it, then translate base-side results to head files by path suffix.
  const budget = opts.maxTraversalNodes ?? 2_000_000;
  const headFiles = new Set(opts.graph.byFile.keys());
  const testSet = knownTests;

  /** Walk one seed set (head ids, or base ids translated to head paths). */
  const walk = (
    seeds: Set<string>,
  ): { blast: string[]; tests: Set<string>; reached: Map<string, Set<string>> } => {
    const headSeeds = new Set<string>();
    const baseSeeds = new Set<string>();
    for (const id of seeds) {
      if (opts.graph.byId.has(id)) headSeeds.add(id);
      else baseSeeds.add(id);
    }
    const blast: string[] = [];
    const tests = new Set<string>();
    const reached = new Map<string, Set<string>>();
    const record = (file: string, type: string, label: string, loc: string): void => {
      blast.push(`${type} ${label} (${file}${loc})`);
      if (testSet.has(file)) {
        tests.add(file);
        return;
      }
      const symbols = reached.get(file) ?? new Set<string>();
      if (type !== "file") symbols.add(label);
      reached.set(file, symbols);
    };
    for (const id of dependents(opts.graph, headSeeds, budget)) {
      const node = opts.graph.byId.get(id);
      if (!node) continue;
      const loc = node.source_location ? `:${node.source_location.start_line}` : "";
      if (node.source_file) record(node.source_file, node.type, node.label, loc);
      else blast.push(`${node.type} ${node.label}`);
    }
    // Seeds that are themselves inside test files select those tests too.
    for (const id of headSeeds) {
      const node = opts.graph.byId.get(id);
      if (node?.source_file && testSet.has(node.source_file)) tests.add(node.source_file);
    }
    if (baseSeeds.size > 0 && opts.baseGraph) {
      for (const id of dependents(opts.baseGraph, baseSeeds, budget)) {
        const node = opts.baseGraph.byId.get(id);
        if (!node?.source_file) continue;
        const headFile = translatePath(node.source_file, headFiles);
        if (headFile === undefined) continue; // dependent itself gone at head — nothing to run
        const loc = node.source_location ? `:${node.source_location.start_line}` : "";
        record(headFile, node.type, node.label, loc);
      }
    }
    return { blast, tests, reached };
  };

  let whole: ReturnType<typeof walk>;
  const files: ChangedFileImpact[] = [];
  try {
    whole = walk(mapping.seeds);
    for (const file of changed) {
      const seeds = mapping.seedsByFile.get(file.path);
      if (seeds === undefined) {
        files.push({ path: file.path, status: file.status, disposition: "ignored", symbols: [], reaches: [], tests: [] });
        continue;
      }
      const own = walk(seeds);
      const symbols = new Set<string>();
      for (const id of seeds) {
        const node = opts.graph.byId.get(id) ?? opts.baseGraph?.byId.get(id);
        if (node && node.type !== "file") symbols.add(node.label);
      }
      files.push({
        path: file.path,
        status: file.status,
        disposition: "mapped",
        symbols: [...symbols].sort(),
        reaches: [...own.reached.entries()]
          .map(([f, syms]) => ({ file: f, symbols: [...syms].sort() }))
          .sort((a, b) => a.file.localeCompare(b.file)),
        tests: [...own.tests].sort(),
      });
    }
  } catch (e) {
    // A truncated walk cannot be told apart from a complete one, so the only
    // safe response is ALL -- never the partial set collected so far.
    if (e instanceof TraversalExhausted) {
      return { kind: "all", reasons: [{ kind: "traversal-exhausted", visited: e.visited, budget: e.budget }] };
    }
    throw e;
  }
  const tests = whole.tests;
  // Files cgraph deliberately skipped were dropped from `changed` above; they
  // still belong in the per-file report, as ignored, in diff order.
  const ignoredByVerdict = parsed.filter((f) => !changed.includes(f));
  for (const file of ignoredByVerdict) {
    files.push({ path: file.path, status: file.status, disposition: "ignored", symbols: [], reaches: [], tests: [] });
  }
  files.sort((a, b) => parsed.findIndex((f) => f.path === a.path) - parsed.findIndex((f) => f.path === b.path));

  // Selection that reaches almost the whole suite bought nothing. Saying so is
  // more honest than listing 95% of the tests as "impacted", and this can only
  // widen the result to ALL -- it never removes a test from the run.
  // A ratio over a tiny denominator is noise, not signal: on a three-test suite
  // any real selection "saturates". Below this floor the whole suite is cheap
  // anyway, so the subset is kept and stays informative.
  const saturationFloor = opts.minSuiteForSaturation ?? 20;
  const saturation = opts.maxSelectedFraction ?? 0.9;
  if (testSet.size >= saturationFloor && tests.size / testSet.size >= saturation) {
    return {
      kind: "all",
      reasons: [
        {
          kind: "selection-saturated",
          selected: tests.size,
          total: testSet.size,
          threshold: saturation,
        },
      ],
    };
  }

  return {
    kind: "subset",
    tests: [...tests].sort(),
    blast: [...new Set(whole.blast)].sort(),
    testsTotal: testSet.size,
    files,
    edges: fileEdges(opts.graph, files, tests),
    ...(opts.graph.contentRoot !== undefined && { contentRoot: opts.graph.contentRoot.sha256 }),
  };
}

/**
 * File-level edges among the files the selection touched: every graph link
 * whose two ends sit in different involved files, collapsed to (dependency ->
 * dependent). This is what the reach figure draws; it carries no node the
 * per-file walk did not already reach.
 */
function fileEdges(graph: CodeGraph, files: ChangedFileImpact[], tests: Set<string>): FileEdge[] {
  const involved = new Set<string>(tests);
  for (const f of files) {
    for (const r of f.reaches) involved.add(r.file);
    for (const abs of graph.byFile.keys()) {
      if (abs.endsWith(`/${f.path}`) || abs === f.path) involved.add(abs);
    }
  }
  const seen = new Set<string>();
  const edges: FileEdge[] = [];
  for (const link of graph.links) {
    const [dependent, dependency] = dependencyDirection(link);
    const from = graph.byId.get(dependency)?.source_file;
    const to = graph.byId.get(dependent)?.source_file;
    if (!from || !to || from === to || !involved.has(from) || !involved.has(to)) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
