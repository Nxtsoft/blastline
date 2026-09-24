import { describe, expect, it } from "vitest";
import { COMMENT_MARKER, renderComment } from "./comment.js";
import type { CommentContext, } from "./comment.js";
import type { Selection } from "./types.js";

const REPO = "/r";
const ctx: CommentContext = { range: "main..HEAD", repo: REPO, version: "0.11.0" };

const subset: Selection = {
  kind: "subset",
  tests: ["/r/src/a.test.ts", "/r/src/b.test.ts"],
  blast: ["function use (/r/src/c.ts:2)", "file c.ts (/r/src/c.ts:1)", "function check (/r/src/a.test.ts:3)"],
  testsTotal: 40,
  files: [
    {
      path: "src/lib.ts",
      status: "modified",
      disposition: "mapped",
      symbols: ["parse", "tokenize", "emit", "walk"],
      reaches: [{ file: "/r/src/c.ts", symbols: ["use"] }],
      tests: ["/r/src/a.test.ts", "/r/src/b.test.ts"],
    },
    { path: "docs/guide.md", status: "modified", disposition: "ignored", symbols: [], reaches: [], tests: [] },
    { path: "docs/faq.md", status: "added", disposition: "ignored", symbols: [], reaches: [], tests: [] },
  ],
  edges: [
    { from: "/r/src/lib.ts", to: "/r/src/c.ts" },
    { from: "/r/src/c.ts", to: "/r/src/a.test.ts" },
    { from: "/r/src/lib.ts", to: "/r/src/b.test.ts" },
  ],
  contentRoot: "c".repeat(64),
};

describe("renderComment: subset", () => {
  it("leads with the marker and the verdict with its denominator", () => {
    const md = renderComment(subset, ctx);
    const lines = md.split("\n");
    expect(lines[0]).toBe(COMMENT_MARKER);
    expect(lines[1]).toBe("### Test impact: 2 of 40 test files reach this diff");
    expect(md).toContain("**2** of 40 `▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯` 5% of the suite");
  });

  it("shows repo-relative paths, never the absolute graph paths", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("- `src/a.test.ts`");
    expect(md).not.toContain("/r/src/a.test.ts");
  });

  it("links paths to the head blob and the shas to a compare view when the repo URL is known", () => {
    const md = renderComment(subset, {
      ...ctx,
      repoUrl: "https://github.com/o/r",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      prNumber: 587,
    });
    expect(md).toContain("[`src/a.test.ts`](https://github.com/o/r/blob/" + "b".repeat(40) + "/src/a.test.ts)");
    expect(md).toContain("| Summary | PR #587 at [`bbbbbbb`](https://github.com/o/r/compare/" + "a".repeat(40) + "..." + "b".repeat(40) + ") |");
    expect(md).toContain("| Compared against | base `aaaaaaa` |");
    expect(md).not.toContain("main..HEAD");
  });

  it("falls back to the raw range when the shas are unknown", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("| Summary | `main..HEAD` |");
  });

  it("tabulates each changed file with its symbols, reach and tests, grouping ignored files by directory", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("| `src/lib.ts` | `parse`, `tokenize`, `emit`, +1 | 1 file | 2 |");
    expect(md).toContain("| 2 files under `docs/` | ignored by policy | | 0 |");
    expect(md).toContain("| Changed | 3 files: 1 mapped to 4 symbols, 2 ignored by policy |");
    expect(md).toContain("| Downstream code | 1 file, 3 dependents |");
  });

  it("embeds the hosted figure with a dark and a light source when given", () => {
    const md = renderComment(subset, { ...ctx, figure: { dark: "https://x/d.svg", light: "https://x/l.svg" } });
    expect(md).toContain('<source media="(prefers-color-scheme: dark)" srcset="https://x/d.svg">');
    expect(md).toContain('src="https://x/l.svg"');
    expect(renderComment(subset, ctx)).not.toContain("<picture>");
  });

  it("groups the blast radius by changed file behind a fold", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("<details><summary>Blast radius by changed file: 3 dependents</summary>");
    expect(md).toContain("- `src/lib.ts` reaches `use` (`src/c.ts`)");
  });

  it("carries the version and the graph root in the footer", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("blastline 0.11.0");
    expect(md).toContain("Graph `ccccccc`");
  });

  it("states plainly when a clean subset selects zero tests", () => {
    const md = renderComment({ ...subset, tests: [], blast: [], files: [], edges: [] }, ctx);
    expect(md).toContain("### Test impact: 0 of 40 test files reach this diff");
    expect(md).toContain("none: no test file depends on the changed code");
  });
});

describe("renderComment: fail-open", () => {
  it("renders every reason kind as a cause with an action, without throwing", () => {
    const md = renderComment(
      {
        kind: "all",
        reasons: [
          { kind: "unmapped-file", path: "x.json" },
          { kind: "stale-graph", expected: "e", actual: "a" },
          { kind: "sparse-graph", edgesPerFile: 1.9, threshold: 3 },
          { kind: "disconnected-tests", coverage: 0.1, threshold: 0.25 },
          { kind: "diff-too-large", files: 300, limit: 200 },
          { kind: "extraction-warning", path: "y.ts" },
          { kind: "graph-unavailable", detail: "no graph" },
          { kind: "no-test-files" },
          { kind: "selection-saturated", selected: 19, total: 20, threshold: 0.9 },
          { kind: "traversal-exhausted", visited: 5, budget: 4 },
          { kind: "invalid-ignore-pattern", pattern: "[", detail: "bad" },
        ],
      },
      ctx,
    );
    expect(md.split("\n")[0]).toBe(COMMENT_MARKER);
    expect(md).toContain("### Test impact: run the full suite");
    expect(md).toContain("> [!WARNING]");
    // ci.yml's action-selftest greps this exact phrase in blastline-comment.md
    expect(md).toContain("Run the full suite");
    expect(md).toContain("| Why | What you can do |");
    expect(md).toContain("| Graph looks under-extracted: 1.9 edges per file (floor 3) |");
    expect(md).toContain("x.json");
    expect(md).not.toContain("undefined");
    // ten non-unmapped reasons, one row each
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Why")).length).toBe(10);
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
    const md = renderComment({ kind: "all", reasons }, ctx);
    expect(md.split("\n").length).toBeLessThan(120);
    expect(md).toContain("901 files have no graph node");
    expect(md).toContain("add a pattern for them to `ignore`");
    expect(md).toContain("research/evidence/run-0");
    expect(md).toContain("bench");
    expect(md).toContain("more");
  });
});
