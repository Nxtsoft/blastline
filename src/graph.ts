import { readFileSync } from "node:fs";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  source_location?: { start_line: number; end_line: number };
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
}

export interface ContentRoot {
  algorithm: string;
  sha256: string;
  leafCount: number;
}

export interface CodeGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** sha256-merkle-v1 root of the source tree the graph was built from (CGraph ≥ the content-root export) */
  contentRoot?: ContentRoot;
  byId: Map<string, GraphNode>;
  /** node lists keyed by absolute source_file */
  byFile: Map<string, GraphNode[]>;
  /** incoming edges: target id -> sources that depend on it, with the relation */
  incoming: Map<string, { from: string; relation: string }[]>;
}

export function loadGraph(path: string): CodeGraph {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    nodes: GraphNode[];
    links: GraphLink[];
    graph?: { content_root?: { algorithm?: string; sha256?: string; leaf_count?: number } };
  };
  const graph = indexGraph(raw.nodes, raw.links);
  const root = raw.graph?.content_root;
  if (root && typeof root.sha256 === "string" && /^[0-9a-f]{64}$/.test(root.sha256)) {
    graph.contentRoot = {
      algorithm: root.algorithm ?? "",
      sha256: root.sha256,
      leafCount: root.leaf_count ?? 0,
    };
  }
  return graph;
}

export function indexGraph(nodes: GraphNode[], links: GraphLink[]): CodeGraph {
  const byId = new Map<string, GraphNode>();
  const byFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.source_file) {
      const list = byFile.get(n.source_file) ?? [];
      list.push(n);
      byFile.set(n.source_file, list);
    }
  }
  const incoming = new Map<string, { from: string; relation: string }[]>();
  for (const l of links) {
    const [from, to] = dependencyDirection(l);
    const list = incoming.get(to) ?? [];
    list.push({ from, relation: l.relation });
    incoming.set(to, list);
  }
  return { nodes, links, byId, byFile, incoming };
}

/**
 * Every CGraph relation points dependency-ward at the source (CALLS
 * caller->callee, imports importer->imported) — except two seam contract
 * relations that read the other way: "endpoint CONSUMED_AT call-site" and
 * "schema MIRRORED_BY type" mean the TARGET depends on the SOURCE. Flip them
 * so a provider-side change flows contract -> consumer code -> consumer tests.
 * Non-seam graphs never carry these relations, so behavior is unchanged there.
 */
export function dependencyDirection(link: GraphLink): [from: string, to: string] {
  return link.relation === "CONSUMED_AT" || link.relation === "MIRRORED_BY"
    ? [link.target, link.source]
    : [link.source, link.target];
}

/**
 * Resolve a repo-relative diff path to the graph nodes of that file, matching
 * on exact path-boundary suffix. Returns the UNION across every matching
 * source_file: in a fused seam graph one changed provider file can be both a
 * real code file (absolute path) and a schema node's canonical file (a
 * repo-relative string), and extra seeds only ever widen the superset — the
 * safe direction.
 */
export function nodesForPath(graph: CodeGraph, relPath: string): GraphNode[] {
  const suffix = `/${relPath}`;
  const matches: GraphNode[] = [];
  for (const [abs, nodes] of graph.byFile) {
    if (abs.endsWith(suffix) || abs === relPath) matches.push(...nodes);
  }
  return matches;
}

/**
 * Resolve an agent-supplied symbol reference to a single graph node for the
 * `check` verifier. Accepts, in order of precedence:
 *   - `file:line`  — the smallest non-file node whose span contains that line
 *   - `file:label` — the node in that file with a matching label
 *   - bare `label` — every non-file node with that label across the graph
 * A bare label (or a `file:label` form) that matches more than one node is
 * reported as ambiguous rather than guessed; nothing matching is not-found. The
 * file part matches on the same path-boundary suffix rule as `nodesForPath`, so
 * a repo-relative reference resolves against the graph's absolute paths.
 */
export type SymbolResolution =
  | { kind: "resolved"; node: GraphNode }
  | { kind: "ambiguous"; nodes: GraphNode[] }
  | { kind: "not-found" };

export function resolveSymbol(graph: CodeGraph, ref: string): SymbolResolution {
  const colon = ref.lastIndexOf(":");
  if (colon > 0) {
    const path = ref.slice(0, colon);
    const selector = ref.slice(colon + 1);
    const fileNodes = nodesForPath(graph, path).filter((n) => n.type !== "file");
    if (fileNodes.length > 0) {
      if (/^\d+$/.test(selector)) {
        const line = Number(selector);
        const containing = fileNodes.filter(
          (n) =>
            n.source_location !== undefined &&
            n.source_location.start_line <= line &&
            n.source_location.end_line >= line,
        );
        if (containing.length === 0) return { kind: "not-found" };
        // Smallest span wins; a file with several finer nodes over one line
        // resolves to the tightest enclosing symbol.
        const span = (n: GraphNode) =>
          (n.source_location as { start_line: number; end_line: number }).end_line -
          (n.source_location as { start_line: number; end_line: number }).start_line;
        const smallest = Math.min(...containing.map(span));
        const tightest = containing.filter((n) => span(n) === smallest);
        return tightest.length === 1
          ? { kind: "resolved", node: tightest[0] as GraphNode }
          : { kind: "ambiguous", nodes: tightest };
      }
      const byLabel = fileNodes.filter((n) => n.label === selector);
      if (byLabel.length === 1) return { kind: "resolved", node: byLabel[0] as GraphNode };
      if (byLabel.length > 1) return { kind: "ambiguous", nodes: byLabel };
      return { kind: "not-found" };
    }
  }
  const byLabel = graph.nodes.filter((n) => n.type !== "file" && n.label === ref);
  if (byLabel.length === 1) return { kind: "resolved", node: byLabel[0] as GraphNode };
  if (byLabel.length > 1) return { kind: "ambiguous", nodes: byLabel };
  return { kind: "not-found" };
}

/**
 * Translate a file path from one graph's tree to another's — a base graph is
 * built from a different checkout (a worktree of the merge-base), so the same
 * repo-relative file carries a different absolute prefix in each graph. The
 * longest path-boundary suffix of `file` that names exactly one candidate
 * wins; a file with no unique counterpart (e.g. deleted at head) translates to
 * nothing.
 */
export function translatePath(file: string, candidates: Iterable<string>): string | undefined {
  const all = [...candidates];
  const segments = file.split("/").filter((s) => s.length > 0);
  for (let k = segments.length; k >= 1; k--) {
    const suffix = `/${segments.slice(segments.length - k).join("/")}`;
    const hits = all.filter((c) => c.endsWith(suffix) || c === suffix.slice(1));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) continue;
  }
  return undefined;
}
