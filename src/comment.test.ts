import { describe, expect, it } from "vitest";
import { renderComment } from "./comment.js";

describe("renderComment", () => {
  it("renders a subset with tests and a collapsible blast radius", () => {
    const md = renderComment(
      { kind: "subset", tests: ["/r/a.test.ts"], blast: ["function use (/r/c.ts:2)"] },
      "main..HEAD",
    );
    expect(md).toContain("main..HEAD");
    expect(md).toContain("- `/r/a.test.ts`");
    expect(md).toContain("Blast radius (1 dependents)");
  });

  it("renders every fail-open reason kind without throwing", () => {
    const md = renderComment(
      {
        kind: "all",
        reasons: [
          { kind: "unmapped-file", path: "x.json" },
          { kind: "stale-graph", expected: "e", actual: "a" },
          { kind: "sparse-graph", edgesPerFile: 1.9, threshold: 3 },
          { kind: "diff-too-large", files: 300, limit: 200 },
          { kind: "extraction-warning", path: "y.ts" },
          { kind: "graph-unavailable", detail: "no graph" },
          { kind: "no-test-files" },
        ],
      },
      "a..b",
    );
    expect(md).toContain("Run the full suite");
    expect(md).toContain("1.9 edges/file");
    expect(md).toContain("x.json");
    expect(md).toContain("no test files at all");
  });


  // A real PR produced ~900 near-identical "has no graph node" bullets, burying
  // the verdict and every other reason. The paths still matter, so they are
  // grouped by directory and kept in full behind a fold -- never dropped.
  it("aggregates a large unmapped-file list instead of one bullet per file", () => {
    const reasons = Array.from({ length: 900 }, (_, i) => ({
      kind: "unmapped-file" as const,
      path: `research/evidence/run-${i}/result.json`,
    }));
    reasons.push({ kind: "unmapped-file" as const, path: "bench/only.json" });
    const md = renderComment({ kind: "all", reasons }, "a..b");
    const lines = md.split("\n").length;
    expect(lines).toBeLessThan(120);
    expect(md).toContain("901 files have no graph node");
    // every directory is accounted for, and nothing is silently dropped
    expect(md).toContain("research/evidence/run-0");
    expect(md).toContain("bench");
    expect(md).toContain("more");
  });

  it("appends the content-root provenance footer when present", () => {
    const md = renderComment(
      { kind: "subset", tests: ["/r/a.test.ts"], blast: [], contentRoot: "c".repeat(64) },
      "a..b",
    );
    expect(md).toContain("sha256-merkle-v1:" + "c".repeat(64));
  });
  it("states plainly when a clean subset selects zero tests", () => {
    const md = renderComment({ kind: "subset", tests: [], blast: [] }, "a..b");
    expect(md).toContain("none — no test file depends");
  });
});
