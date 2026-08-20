import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTestPath, testFiles, testReachability } from "./detect.js";
import { loadGraph } from "./graph.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

describe("isTestPath", () => {
  it("matches Vitest/Jest conventions", () => {
    expect(isTestPath("src/lib.test.ts")).toBe(true);
    expect(isTestPath("src/Thing.spec.tsx")).toBe(true);
    expect(isTestPath("src/__tests__/thing.ts")).toBe(true);
    expect(isTestPath("a/b.test.mjs")).toBe(true);
  });

  it("matches pytest collection defaults", () => {
    expect(isTestPath("tests/test_core.py")).toBe(true);
    expect(isTestPath("pkg/core_test.py")).toBe(true);
    expect(isTestPath("test_top_level.py")).toBe(true);
  });

  it("matches Go's compiler-enforced convention", () => {
    expect(isTestPath("pkg/core_test.go")).toBe(true);
    expect(isTestPath("core_test.go")).toBe(true);
  });

  it("matches C/C++ googletest/ctest conventions", () => {
    expect(isTestPath("tests/smoke/cpp_extractor_test.cpp")).toBe(true);
    expect(isTestPath("src/engine/graph_builder_test.cc")).toBe(true);
    expect(isTestPath("lib/parse_test.cxx")).toBe(true);
    expect(isTestPath("core/ring_buffer_test.c")).toBe(true);
    expect(isTestPath("tests/test_pipeline.cpp")).toBe(true);
  });

  it("does not match near-misses", () => {
    expect(isTestPath("src/latest.ts")).toBe(false);
    expect(isTestPath("src/contest.spec/readme.ts")).toBe(false);
    expect(isTestPath("src/test/helpers.ts")).toBe(false); // plain "test" dir is not __tests__
    expect(isTestPath("src/protest.ts")).toBe(false);
    expect(isTestPath("tests/conftest.py")).toBe(false); // fixtures, not tests
    expect(isTestPath("tests/helpers.py")).toBe(false); // tests/ dir alone is no signal
    expect(isTestPath("pkg/attest.py")).toBe(false);
    expect(isTestPath("pkg/latest.go")).toBe(false);
    expect(isTestPath("pkg/contest.go")).toBe(false);
    expect(isTestPath("tests/fuzz/extractor_fuzzer.cpp")).toBe(false); // fuzz harness, not a test
    expect(isTestPath("src/latest.cpp")).toBe(false);
    expect(isTestPath("include/graph_test.h")).toBe(false); // headers are shared fixtures
    expect(isTestPath("src/contest.cc")).toBe(false);
  });
});

describe("testFiles", () => {
  it("collects test file paths from the graph", () => {
    expect(testFiles(loadGraph(FIXTURE))).toEqual(new Set(["/repo/src/lib.test.ts"]));
  });
});

describe("testReachability", () => {
  it("measures the fraction of non-test symbols reachable from tests", () => {
    // f_test -> fn_parse (imports) and -> f_lib (imports_from) -> contains all
    // three lib symbols; fn_use (the consumer) is upstream and unreachable.
    expect(testReachability(loadGraph(FIXTURE))).toBeCloseTo(3 / 4);
  });

  it("returns null when the graph has no test files", () => {
    const g = loadGraph(FIXTURE);
    const stripped = {
      ...g,
      nodes: g.nodes.filter((n) => !n.source_file?.includes("test")),
    };
    expect(testReachability(stripped)).toBeNull();
  });
});
