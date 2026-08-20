import type { CodeGraph } from "./graph.js";

/**
 * Transitive dependents of the seed set: BFS over incoming edges.
 *
 * Every relation CGraph emits for TS points dependency-ward at the source end
 * (CALLS caller->callee, imports/imports_from importer->imported,
 * inherits child->parent, re_exports barrel->origin, contains parent->child —
 * a parent's content includes its children), so incoming edges of any relation
 * mean "depends on". Seeds themselves are excluded from the result.
 *
 * The dispatch barrier: a node reached by walking a `dispatches_to` edge
 * backwards is an interface CONTRACT the changed code implements. Its CALLERS
 * are genuinely affected — any of them may dispatch to the changed
 * implementation — but the contract's structural neighborhood is not: the
 * interface declaration, its other implementers, and their methods did not
 * change. Without the barrier one implementation's edit cascades
 * impl -> contract -> interface -> every sibling implementer -> all their
 * callers, selecting most of an interface-heavy package (measured on
 * gorilla/mux: 45.9% mean subsets). From a contract-reached node the walk
 * therefore continues only through consumer relations; a consumer so reached
 * is real code and resumes the unrestricted walk.
 */
const STRUCTURAL_RELATIONS = new Set(["contains", "method", "method_of", "implements", "inherits"]);

export function dependents(graph: CodeGraph, seeds: Iterable<string>): Set<string> {
  const seedSet = new Set(seeds);
  // Modes: full walk (false) vs contract-reached (true). A node first seen in
  // contract mode may be revisited in full mode — full expands strictly more.
  const seenFull = new Set(seedSet);
  const seenContract = new Set<string>();
  const queue: { id: string; contract: boolean }[] = [...seedSet].map((id) => ({
    id,
    contract: false,
  }));
  const result = new Set<string>();
  while (queue.length > 0) {
    const { id, contract } = queue.pop() as { id: string; contract: boolean };
    for (const { from, relation } of graph.incoming.get(id) ?? []) {
      if (contract && STRUCTURAL_RELATIONS.has(relation)) continue;
      const nextContract = relation === "dispatches_to";
      if (nextContract) {
        if (seenContract.has(from) || seenFull.has(from)) continue;
        seenContract.add(from);
      } else {
        if (seenFull.has(from)) continue;
        seenFull.add(from);
      }
      result.add(from);
      queue.push({ id: from, contract: nextContract });
    }
  }
  for (const s of seedSet) result.delete(s);
  return result;
}
