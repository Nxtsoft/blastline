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
        ],
      },
      "a..b",
    );
    expect(md).toContain("Run the full suite");
    expect(md).toContain("1.9 edges/file");
    expect(md).toContain("`x.json`");
  });

  it("states plainly when a clean subset selects zero tests", () => {
    const md = renderComment({ kind: "subset", tests: [], blast: [] }, "a..b");
    expect(md).toContain("none — no test file depends");
  });
});
