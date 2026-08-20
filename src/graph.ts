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
