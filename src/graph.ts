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
  /** incoming edges: target id -> sources that depend on it */
  incoming: Map<string, string[]>;
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
  const incoming = new Map<string, string[]>();
  for (const l of links) {
    const list = incoming.get(l.target) ?? [];
    list.push(l.source);
    incoming.set(l.target, list);
  }
  return { nodes, links, byId, byFile, incoming };
}

/**
 * Resolve a repo-relative diff path to the graph nodes of that file.
 * Graph source_file paths are absolute; match on exact path-boundary suffix.
 */
export function nodesForPath(graph: CodeGraph, relPath: string): GraphNode[] {
  const suffix = `/${relPath}`;
  for (const [abs, nodes] of graph.byFile) {
    if (abs.endsWith(suffix) || abs === relPath) return nodes;
  }
  return [];
}
