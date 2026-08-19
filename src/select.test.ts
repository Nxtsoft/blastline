import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraph } from "./graph.js";
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

  it("is deterministic: identical inputs produce identical output", () => {
    const a = JSON.stringify(select(DIFF_IN_PARSE, { graph: g, minDensity: 0 }));
    const b = JSON.stringify(select(DIFF_IN_PARSE, { graph: g, minDensity: 0 }));
    expect(a).toBe(b);
  });
});
