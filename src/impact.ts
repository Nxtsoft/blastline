import type { CodeGraph } from "./graph.js";

/**
 * Transitive dependents of the seed set: BFS over incoming edges.
 *
 * Every relation CGraph emits for TS points dependency-ward at the source end
 * (CALLS caller->callee, imports/imports_from importer->imported,
 * inherits child->parent, re_exports barrel->origin, contains parent->child —
 * a parent's content includes its children), so incoming edges of any relation
 * mean "depends on". Seeds themselves are excluded from the result.
 */
export function dependents(graph: CodeGraph, seeds: Iterable<string>): Set<string> {
  const seedSet = new Set(seeds);
  const seen = new Set(seedSet);
  const queue = [...seedSet];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const dep of graph.incoming.get(current) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  for (const s of seedSet) seen.delete(s);
  return seen;
}
