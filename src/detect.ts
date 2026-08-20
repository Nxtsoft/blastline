import type { CodeGraph } from "./graph.js";
import { dependencyDirection } from "./graph.js";

/**
 * Test-file conventions per ecosystem:
 * - JS/TS (Vitest/Jest): *.test.* / *.spec.* files and __tests__ directories
 * - Python (pytest collection defaults): test_*.py and *_test.py — a tests/
 *   directory alone is NOT a signal (helpers and fixtures live there too),
 *   and conftest.py is fixture plumbing, not a test
 * - Go: *_test.go, the compiler-enforced convention
 * - C/C++ (googletest/ctest convention): *_test.<ext> and test_*.<ext> for
 *   translation units only (.c/.cc/.cpp/.cxx) — headers are shared fixtures,
 *   and fuzz harnesses (*_fuzzer.cpp) deliberately do not match
 */
export function isTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)__tests__\//.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.py$/.test(path) ||
    /_test\.go$/.test(path) ||
    /_test\.(c|cc|cpp|cxx)$/.test(path) ||
    /(^|\/)test_[^/]*\.(c|cc|cpp|cxx)$/.test(path)
  );
}

/**
 * The absolute source_file paths of every test file in the graph. Selection is
 * reported at file granularity — that is what Vitest/Jest accept as arguments.
 */
export function testFiles(graph: CodeGraph): Set<string> {
  const files = new Set<string>();
  for (const n of graph.nodes) {
    if (n.source_file && isTestPath(n.source_file)) files.add(n.source_file);
  }
  return files;
}

/**
 * The fraction of non-test symbols forward-reachable from the repo's tests —
 * the graph-side answer to "can tests see the code at all?". A graph can pass
 * the edge-density floor and still be blind for selection when its test files
 * have no resolved edges into the implementation (measured: Go receiver-method
 * calls and Python imports/instantiations both extract that way today, at 0.11
 * and 0.07 coverage, versus 0.52-1.00 on healthy TS graphs). Returns null when
 * the graph has no test files or no non-test symbols — nothing to judge.
 */
export function testReachability(graph: CodeGraph): number | null {
  const outgoing = new Map<string, string[]>();
  for (const l of graph.links) {
    const [from, to] = dependencyDirection(l);
    const list = outgoing.get(from) ?? [];
    list.push(to);
    outgoing.set(from, list);
  }
  const seeds = graph.nodes
    .filter((n) => n.source_file && isTestPath(n.source_file))
    .map((n) => n.id);
  const targets = graph.nodes.filter(
    (n) => n.type !== "file" && n.source_file && !isTestPath(n.source_file),
  );
  if (seeds.length === 0 || targets.length === 0) return null;

  const seen = new Set(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  const reached = targets.filter((n) => seen.has(n.id)).length;
  return reached / targets.length;
}
