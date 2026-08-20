import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexGraph, loadGraph } from "./graph.js";
import { select } from "./select.js";

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
