import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexGraph, loadGraph } from "./graph.js";
import { select } from "./select.js";
import type { PathVerdicts } from "./paths.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));
const g = loadGraph(FIXTURE);

const DIFF_IN_PARSE = `diff --git a/src/lib.ts b/src/lib.ts
index 1..2 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -9,0 +10,1 @@
+  x();
`;

const DIFF_WITH_DOC = DIFF_IN_PARSE + `diff --git a/README.md b/README.md
index 3..4 100644
--- a/README.md
+++ b/README.md
@@ -1,0 +2,1 @@
+hello
`;

describe("select", () => {
  it("returns the impacted test subset for a symbol-level edit", () => {
    const sel = select(DIFF_IN_PARSE, { graph: g, minDensity: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.tests).toEqual(["/repo/src/lib.test.ts"]);
    expect(sel.blast.join("\n")).toContain("function use");
  });

  // A graph with no test-file nodes cannot answer "which tests does this change
  // affect". testReachability returns null for that graph, which SKIPS the
  // disconnected-tests guard rather than tripping it, so selection used to run
  // to completion and intersect against an empty test set -- returning
  // {kind:"subset", tests:[]}, i.e. "run nothing", with no reason and no
  // warning. Every other fail-open path is over-conservative; this one was the
  // opposite, so it is the one that could actually let a regression through.
  it("fails open when the graph contains no test files at all", () => {
    const node = (id: string, type: string, file: string) => ({
      id,
      label: id,
      type,
      source_file: file,
    });
    const noTests = indexGraph(
      [
        node("f_lib", "file", "/repo/src/lib.ts"),
        node("fn_parse", "function", "/repo/src/lib.ts"),
        node("f_consumer", "file", "/repo/src/consumer.ts"),
        node("fn_use", "function", "/repo/src/consumer.ts"),
      ],
      [
        { source: "f_lib", target: "fn_parse", relation: "contains" },
        { source: "f_consumer", target: "fn_use", relation: "contains" },
        { source: "fn_use", target: "fn_parse", relation: "CALLS" },
      ],
    );
    const sel = select(DIFF_IN_PARSE, { graph: noTests, minDensity: 0 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons).toContainEqual({ kind: "no-test-files" });
  });

  // cgraph PR #73's exact shape: a diff dominated by files cgraph deliberately
  // ignores. Two guards fired there, and an --ignore rule could fix neither:
  // the size guard reads changed.length BEFORE mapping applies `ignore`, and
  // every ignored file still produced an unmapped-file reason. cgraph's own
  // verdict resolves both, because "skipped by rule" is evidence of no effect
  // rather than a user's declaration of irrelevance.
  const verdicts: PathVerdicts = {
    ignoredDirectories: ["research"],
    ignoredFiles: new Set<string>(),
    unindexed: new Set<string>([".github/workflows/ci.yml"]),
  };

  function diffOver(paths: string[]): string {
    return paths
      .map(
        (p) =>
          `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n@@ -1,0 +2,1 @@\n+x\n`,
      )
      .join("");
  }

  it("a large diff of cgraph-ignored files no longer trips the size guard", () => {
    const many = Array.from({ length: 400 }, (_, i) => `research/evidence/run-${i}/result.json`);
    const diff = diffOver([...many, "src/lib.ts"]);
    // Without the verdicts: 401 files, over the limit of 200.
    const before = select(diff, { graph: g, minDensity: 0, maxFiles: 200 });
    expect(before.kind).toBe("all");
    if (before.kind === "all") {
      expect(before.reasons).toContainEqual({ kind: "diff-too-large", files: 401, limit: 200 });
    }
    // With them: 400 are skipped by rule, so only src/lib.ts is counted.
    const after = select(diff, { graph: g, minDensity: 0, maxFiles: 200, pathVerdicts: verdicts });
    expect(after.kind).toBe("subset");
  });

  // The safety half: an unindexed file must still fail open. cgraph visited it
  // and no extractor claimed it, so the graph may be incomplete because of it.
  it("an unindexed file still fails open even with verdicts present", () => {
    const diff = diffOver(["research/evidence/a.json", ".github/workflows/ci.yml"]);
    const sel = select(diff, { graph: g, minDensity: 0, pathVerdicts: verdicts });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons).toContainEqual({ kind: "unmapped-file", path: ".github/workflows/ci.yml" });
    // and the ignored one contributed no reason at all
    expect(sel.reasons.some((r) => r.kind === "unmapped-file" && r.path.startsWith("research/"))).toBe(false);
  });

  // File count was never a safety property: selection is a union of per-file
  // sound supersets, and count does not enter that argument. It is opt-in now.
  it("does not fail open on a large diff by default", () => {
    const many = Array.from({ length: 500 }, (_, i) => `research/evidence/run-${i}/result.json`);
    const diff = diffOver([...many, "src/lib.ts"]);
    const sel = select(diff, { graph: g, minDensity: 0, pathVerdicts: verdicts });
    expect(sel.kind).toBe("subset");
  });

  it("still fails open on a large diff when --max-files is set explicitly", () => {
    const diff = diffOver(Array.from({ length: 30 }, (_, i) => `research/e/${i}.json`).concat(["src/lib.ts"]));
    const sel = select(diff, { graph: g, minDensity: 0, maxFiles: 10 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons).toContainEqual({ kind: "diff-too-large", files: 31, limit: 10 });
  });

  // The safety property of the budget: an exhausted walk must produce ALL, never
  // the partial set collected so far. A truncated walk is indistinguishable from
  // a complete one, so emitting it would silently drop tests.
  it("an exhausted traversal fails open instead of returning what it walked", () => {
    const sel = select(DIFF_IN_PARSE, { graph: g, minDensity: 0, maxTraversalNodes: 1 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("traversal-exhausted");
  });

  // A ratio over a tiny denominator is noise; the floor keeps small suites
  // informative rather than collapsing them to ALL.
  it("does not saturate on a suite below the floor", () => {
    const sel = select(DIFF_IN_PARSE, { graph: g, minDensity: 0, maxSelectedFraction: 0.5 });
    expect(sel.kind).toBe("subset");
  });

  it("saturates when the selection reaches nearly the whole suite", () => {
    const sel = select(DIFF_IN_PARSE, {
      graph: g,
      minDensity: 0,
      maxSelectedFraction: 0.5,
      minSuiteForSaturation: 1,
    });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("selection-saturated");
  });

  it("fails open to ALL when the diff touches an unmapped file", () => {
    const sel = select(DIFF_WITH_DOC, { graph: g, minDensity: 0 });
    expect(sel).toEqual({ kind: "all", reasons: [{ kind: "unmapped-file", path: "README.md" }] });
  });

  it("an ignore rule rescues the selection for declared-irrelevant files", () => {
    const sel = select(DIFF_WITH_DOC, { graph: g, minDensity: 0, ignore: (p) => p.endsWith(".md") });
    expect(sel.kind).toBe("subset");
  });

  it("fails open when the graph predates the head commit", () => {
    const sel = select(DIFF_IN_PARSE, { graph: g, minDensity: 0, graphMtimeMs: 1000, headCommitMs: 2000 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("stale-graph");
  });

  it("fails open when the diff exceeds the file budget", () => {
    const sel = select(DIFF_WITH_DOC, { graph: g, minDensity: 0, maxFiles: 1 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons.map((r) => r.kind)).toContain("diff-too-large");
  });


  it("fails open by default on an under-extracted graph (bench finding)", () => {
    // The fixture averages 2.0 edges per file node, below the default floor of 3.
    const sel = select(DIFF_IN_PARSE, { graph: g });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]).toEqual({ kind: "sparse-graph", edgesPerFile: 2, threshold: 3 });
  });


  it("fails open when tests cannot reach the code (disconnected-tests)", () => {
    // Sever every edge leaving the test file: tests still exist, but they can
    // reach nothing — the exact shape broken Go/Python extraction produces.
    const severed = indexGraph(
      g.nodes,
      g.links.filter((l) => l.source !== "f_test"),
    );
    const sel = select(DIFF_IN_PARSE, { graph: severed, minDensity: 0 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]).toEqual({ kind: "disconnected-tests", coverage: 0, threshold: 0.25 });
  });


  it("carries the graph's content root as provenance on subsets", () => {
    const sel = select(DIFF_IN_PARSE, { graph: g, minDensity: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.contentRoot).toBe("a".repeat(64));
  });

  it("pins to an expected content root: match passes, mismatch fails open", () => {
    const ok = select(DIFF_IN_PARSE, { graph: g, minDensity: 0, expectedContentRoot: "a".repeat(64) });
    expect(ok.kind).toBe("subset");
    const bad = select(DIFF_IN_PARSE, { graph: g, minDensity: 0, expectedContentRoot: "b".repeat(64) });
    expect(bad.kind).toBe("all");
    if (bad.kind !== "all") return;
    expect(bad.reasons[0]?.kind).toBe("stale-graph");
  });

  it("fails open when a pin is requested but the graph carries no root", () => {
    const bare = indexGraph(g.nodes, g.links); // indexGraph never sets contentRoot
    const sel = select(DIFF_IN_PARSE, { graph: bare, minDensity: 0, expectedContentRoot: "a".repeat(64) });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(JSON.stringify(sel.reasons[0])).toContain("no content root");
  });

  it("is deterministic: identical inputs produce identical output", () => {
    const a = JSON.stringify(select(DIFF_IN_PARSE, { graph: g, minDensity: 0 }));
    const b = JSON.stringify(select(DIFF_IN_PARSE, { graph: g, minDensity: 0 }));
    expect(a).toBe(b);
  });

  it("walks deletion seeds in the BASE graph and translates dependents across trees", () => {
    // The base graph is built from a merge-base worktree, so it lives under a
    // DIFFERENT absolute root than the head graph and its node ids never
    // resolve at head. A pure file deletion must still select the surviving
    // tests that depended on the deleted symbols — via a base-graph walk, not
    // a head lookup of foreign ids.
    const baseGraph = indexGraph(
      [
        { id: "b_lib", label: "lib.ts", type: "file", source_file: "/base/src/lib.ts" },
        {
          id: "b_parse",
          label: "parse",
          type: "function",
          source_file: "/base/src/lib.ts",
          source_location: { start_line: 1, end_line: 20 },
        },
        { id: "b_test", label: "lib.test.ts", type: "file", source_file: "/base/src/lib.test.ts" },
        { id: "b_gone_test", label: "gone.test.ts", type: "file", source_file: "/base/src/gone.test.ts" },
        { id: "b_other", label: "other.ts", type: "file", source_file: "/base/src/other.ts" },
      ],
      [
        { source: "b_lib", target: "b_parse", relation: "contains" },
        { source: "b_test", target: "b_parse", relation: "imports" },
        { source: "b_gone_test", target: "b_parse", relation: "imports" }, // deleted at head too
      ],
    );
    const headGraph = indexGraph(
      [
        { id: "h_test", label: "lib.test.ts", type: "file", source_file: "/head/src/lib.test.ts" },
        { id: "h_other", label: "other.ts", type: "file", source_file: "/head/src/other.ts" },
        { id: "h_other_test", label: "other.test.ts", type: "file", source_file: "/head/src/other.test.ts" },
      ],
      [{ source: "h_other_test", target: "h_other", relation: "imports" }],
    );
    const deletionDiff = `diff --git a/src/lib.ts b/src/lib.ts
deleted file mode 100644
index 1..0
--- a/src/lib.ts
+++ /dev/null
@@ -1,20 +0,0 @@
-export function parse() {}
`;
    const sel = select(deletionDiff, {
      graph: headGraph,
      baseGraph,
      minDensity: 0,
      minTestReachability: 0,
    });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    // The surviving dependent test is selected under its HEAD path; the test
    // that was itself deleted (nothing to run) is not.
    expect(sel.tests).toEqual(["/head/src/lib.test.ts"]);
    // The unrelated test is not dragged in.
    expect(sel.tests).not.toContain("/head/src/other.test.ts");
  });
});

describe("select: per-file impact for the comment", () => {
  it("reports each changed file with its symbols, reach and tests, plus the file edges and the test total", () => {
    const sel = select(DIFF_WITH_DOC, { graph: g, minDensity: 0, ignore: (p) => p.endsWith(".md") });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.testsTotal).toBe(1);
    expect(sel.files.map((f) => [f.path, f.disposition])).toEqual([
      ["src/lib.ts", "mapped"],
      ["README.md", "ignored"],
    ]);
    const lib = sel.files[0]!;
    expect(lib.symbols.length).toBeGreaterThan(0);
    expect(lib.tests).toEqual(["/repo/src/lib.test.ts"]);
    expect(lib.reaches.map((r) => r.file)).toContain("/repo/src/consumer.ts");
    expect(lib.reaches.find((r) => r.file === "/repo/src/consumer.ts")!.symbols.length).toBeGreaterThan(0);
    // the reach of one file never lists a test file: tests live in `tests`
    expect(lib.reaches.some((r) => r.file.endsWith(".test.ts"))).toBe(false);
    expect(sel.edges).toContainEqual({ from: "/repo/src/lib.ts", to: "/repo/src/consumer.ts" });
    expect(sel.edges).toContainEqual({ from: "/repo/src/lib.ts", to: "/repo/src/lib.test.ts" });
    // every edge end is a file the selection touched
    const involved = new Set([...sel.tests, ...sel.files.flatMap((f) => f.reaches.map((r) => r.file)), "/repo/src/lib.ts"]);
    for (const e of sel.edges) {
      expect(involved.has(e.from)).toBe(true);
      expect(involved.has(e.to)).toBe(true);
    }
  });

  it("keeps the union of per-file walks equal to the whole-diff walk", () => {
    const sel = select(DIFF_IN_PARSE, { graph: g, minDensity: 0 });
    if (sel.kind !== "subset") throw new Error("expected subset");
    const perFile = new Set(sel.files.flatMap((f) => f.tests));
    expect([...perFile].sort()).toEqual(sel.tests);
  });
});
