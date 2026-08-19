import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTestPath, testFiles } from "./detect.js";
import { loadGraph } from "./graph.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

describe("isTestPath", () => {
  it("matches Vitest/Jest conventions", () => {
    expect(isTestPath("src/lib.test.ts")).toBe(true);
    expect(isTestPath("src/Thing.spec.tsx")).toBe(true);
    expect(isTestPath("src/__tests__/thing.ts")).toBe(true);
    expect(isTestPath("a/b.test.mjs")).toBe(true);
  });

  it("does not match near-misses", () => {
    expect(isTestPath("src/latest.ts")).toBe(false);
    expect(isTestPath("src/contest.spec/readme.ts")).toBe(false);
    expect(isTestPath("src/test/helpers.ts")).toBe(false); // plain "test" dir is not __tests__
    expect(isTestPath("src/protest.ts")).toBe(false);
  });
});

describe("testFiles", () => {
  it("collects test file paths from the graph", () => {
    expect(testFiles(loadGraph(FIXTURE))).toEqual(new Set(["/repo/src/lib.test.ts"]));
  });
});
