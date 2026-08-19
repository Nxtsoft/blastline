import type { CodeGraph } from "./graph.js";

/** Vitest/Jest conventions: *.test.* / *.spec.* files and __tests__ directories. */
export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
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
