import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { CodeGraph, GraphNode } from "./graph.js";
import { loadGraph, resolveSymbol } from "./graph.js";
import { dependents } from "./impact.js";
import { daemonContentRoot } from "./run.js";
import { fileMtimeMs } from "./select.js";
import type { FailOpenReason } from "./types.js";

/** A symbol that references the subject: an incoming (or transitive) dependent. */
export interface Caller {
  id: string;
  label: string;
  /** the node's graph type (function, class, file, …) */
  kind: string;
  /** the incoming relation (direct callers) or "transitive" (walked) */
  relation: string;
  file?: string;
  line?: number;
}

/** The resolved subject symbol. */
export interface SymbolRef {
  id: string;
  label: string;
  kind: string;
  file?: string;
  line?: number;
}

/** Why a check could not produce a trusted answer — reuses selection fail-opens. */
export type CheckReason =
  | { kind: "symbol-not-found"; symbol: string }
  | { kind: "symbol-ambiguous"; symbol: string; matches: SymbolRef[] }
  | FailOpenReason;

/**
 * The one caveat every empty result carries: `check` refutes, it never
 * certifies. Static reachability cannot see dynamic dispatch, reflection, or
 * macro-generated call sites, so "no static callers" is not "safe to delete".
 */
export const NO_STATIC_CALLERS_CAVEAT =
  "no static callers found — NOT a certificate that the symbol is unused: dynamic dispatch, " +
  "reflection, and macro-generated calls are invisible to the graph. `check` refutes claims, " +
  "it never certifies them.";

/** The outcome of a claim check: an answer, or a fail-open with reasons. */
export type CheckResult =
  | {
      kind: "checked";
      claim: "no-other-callers";
      symbol: SymbolRef;
      /** refuted = callers remain beyond the exclusion set; otherwise no-static-callers */
      verdict: "refuted" | "no-static-callers";
      callers: Caller[];
      excluded: Caller[];
      /** present only on no-static-callers: the refuter-not-certifier caveat */
      caveat?: string;
      contentRoot?: string;
    }
  | { kind: "fail-open"; reasons: CheckReason[] };

export interface CheckOptions {
  graph: CodeGraph;
  /** the subject symbol reference: file:line | file:label | bare label */
  symbol: string;
  /** callers the agent is already updating — subtracted to ask "no OTHER callers" */
  exclude?: string[];
  /** walk transitive dependents instead of just direct callers */
  transitive?: boolean;
  /** freshness/graph fail-open reasons pre-computed by the IO layer (runCheck) */
  reasons?: FailOpenReason[];
}

function toRef(node: GraphNode): SymbolRef {
  return {
    id: node.id,
    label: node.label,
    kind: node.type,
    ...(node.source_file !== undefined && { file: node.source_file }),
    ...(node.source_location !== undefined && { line: node.source_location.start_line }),
  };
}

/**
 * The pure claim check: subject symbol in, callers + verdict out. Deterministic
 * (callers sorted by id). Graph and freshness IO happens in runCheck; this is
 * the testable core, the `select()` of the verifier.
 */
export function checkCallers(opts: CheckOptions): CheckResult {
  const reasons: CheckReason[] = [...(opts.reasons ?? [])];
  if (reasons.length > 0) return { kind: "fail-open", reasons };

  const resolution = resolveSymbol(opts.graph, opts.symbol);
  if (resolution.kind === "not-found") {
    return { kind: "fail-open", reasons: [{ kind: "symbol-not-found", symbol: opts.symbol }] };
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "fail-open",
      reasons: [{ kind: "symbol-ambiguous", symbol: opts.symbol, matches: resolution.nodes.map(toRef) }],
    };
  }
  const subject = resolution.node;

  // Direct callers carry their real incoming relation; a transitive walk loses
  // per-edge relations, so those are tagged "transitive". A `contains` incoming
  // edge is the symbol's own declaring file/module — structural parentage, not a
  // reference — so it is not a caller and is dropped from the direct query.
  const found = new Map<string, string>(); // caller id -> relation
  if (opts.transitive) {
    for (const id of dependents(opts.graph, [subject.id])) found.set(id, "transitive");
  } else {
    for (const { from, relation } of opts.graph.incoming.get(subject.id) ?? []) {
      if (relation === "contains") continue;
      if (from !== subject.id && !found.has(from)) found.set(from, relation);
    }
  }

  // The exclusion set: the callers the agent says it is already updating.
  const excludedIds = new Set<string>();
  for (const ref of opts.exclude ?? []) {
    const r = resolveSymbol(opts.graph, ref);
    if (r.kind === "resolved") excludedIds.add(r.node.id);
    else if (r.kind === "ambiguous") for (const n of r.nodes) excludedIds.add(n.id);
  }

  const toCaller = (id: string, relation: string): Caller | null => {
    const node = opts.graph.byId.get(id);
    if (!node) return null;
    return {
      id,
      label: node.label,
      kind: node.type,
      relation,
      ...(node.source_file !== undefined && { file: node.source_file }),
      ...(node.source_location !== undefined && { line: node.source_location.start_line }),
    };
  };

  const callers: Caller[] = [];
  const excluded: Caller[] = [];
  for (const [id, relation] of found) {
    const caller = toCaller(id, relation);
    if (!caller) continue;
    (excludedIds.has(id) ? excluded : callers).push(caller);
  }
  const byId = (a: Caller, b: Caller) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  callers.sort(byId);
  excluded.sort(byId);

  const verdict = callers.length > 0 ? "refuted" : "no-static-callers";
  return {
    kind: "checked",
    claim: "no-other-callers",
    symbol: toRef(subject),
    verdict,
    callers,
    excluded,
    ...(verdict === "no-static-callers" && { caveat: NO_STATIC_CALLERS_CAVEAT }),
    ...(opts.graph.contentRoot !== undefined && { contentRoot: opts.graph.contentRoot.sha256 }),
  };
}

export interface RunCheckOptions {
  repo: string;
  symbol: string;
  exclude?: string[];
  transitive?: boolean;
  graphPath?: string;
  expectedContentRoot?: string;
  daemonVerify?: boolean;
}

/**
 * The IO entry point shared by the CLI and MCP: load the graph, apply the
 * freshness guard (content-root pin, daemon pin, and graph-older-than-HEAD
 * staleness), then run the pure check. Never throws — an unreadable graph is a
 * graph-unavailable fail-open, exactly like runSelection.
 */
export function runCheck(o: RunCheckOptions): CheckResult {
  const repo = resolve(o.repo);
  const graphPath = o.graphPath ?? resolve(repo, "cgraph-out/graph.json");
  let graph: CodeGraph;
  try {
    graph = loadGraph(graphPath);
  } catch (e) {
    return {
      kind: "fail-open",
      reasons: [{ kind: "graph-unavailable", detail: `cannot load graph at ${graphPath}: ${(e as Error).message}` }],
    };
  }

  const reasons: FailOpenReason[] = [];

  let expectedContentRoot = o.expectedContentRoot;
  if (o.daemonVerify) {
    const daemon = daemonContentRoot(repo);
    if (daemon.root === undefined) {
      return {
        kind: "fail-open",
        reasons: [
          {
            kind: "graph-unavailable",
            detail: `daemon verification requested but ${daemon.error ?? "no root returned"}`,
          },
        ],
      };
    }
    expectedContentRoot = daemon.root;
  }
  if (expectedContentRoot !== undefined) {
    const actual = graph.contentRoot?.sha256;
    if (actual !== expectedContentRoot) {
      reasons.push({
        kind: "stale-graph",
        expected: `content root ${expectedContentRoot}`,
        actual: actual ? `content root ${actual}` : "graph carries no content root",
      });
    }
  }

  // A graph built before the current HEAD commit cannot vouch for the tree the
  // agent is editing — the same staleness the diff path applies against the
  // range's head, here against HEAD.
  const graphMtimeMs = fileMtimeMs(graphPath);
  try {
    const ct = execFileSync("git", ["-C", repo, "log", "-1", "--format=%ct", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const headCommitMs = Number(ct) * 1000;
    if (graphMtimeMs !== undefined && Number.isFinite(headCommitMs) && graphMtimeMs < headCommitMs) {
      reasons.push({
        kind: "stale-graph",
        expected: `graph built after head commit (${new Date(headCommitMs).toISOString()})`,
        actual: `graph.json mtime ${new Date(graphMtimeMs).toISOString()}`,
      });
    }
  } catch {
    // Not a git repo, or no commits — skip the mtime-vs-HEAD guard, keep any
    // explicit content-root pin above.
  }

  return checkCallers({
    graph,
    symbol: o.symbol,
    ...(o.exclude !== undefined && { exclude: o.exclude }),
    ...(o.transitive === true && { transitive: true }),
    ...(reasons.length > 0 && { reasons }),
  });
}
