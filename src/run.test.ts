import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSelection } from "./run.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

const DIFF = `diff --git a/src/lib.ts b/src/lib.ts
index 1..2 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -9,0 +10,1 @@
+  x();
`;

describe("runSelection", () => {
  it("selects from direct diff text against an explicit graph", () => {
    const sel = runSelection({ repo: "/anywhere", diffText: DIFF, graphPath: FIXTURE, minDensity: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.tests).toEqual(["/repo/src/lib.test.ts"]);
  });

  it("fails open instead of throwing when the graph path is unreadable", () => {
    const sel = runSelection({ repo: "/anywhere", diffText: DIFF, graphPath: "/nope/graph.json" });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("graph-unavailable");
  });

  it("fails open when no diff source is given at all", () => {
    const sel = runSelection({ repo: "/anywhere", graphPath: FIXTURE });
    expect(sel.kind).toBe("all");
  });

  it("applies ignore regexes supplied as strings", () => {
    const withDoc = DIFF + `diff --git a/README.md b/README.md
index 3..4 100644
--- a/README.md
+++ b/README.md
@@ -1,0 +2,1 @@
+hi
`;
    const sel = runSelection({
      repo: "/anywhere",
      diffText: withDoc,
      graphPath: FIXTURE,
      minDensity: 0,
      ignore: ["\\.md$"],
    });
    expect(sel.kind).toBe("subset");
  });

  it("names an unparseable ignore pattern instead of blaming the graph", () => {
    // A glob passed where a regex is expected — `**` is "nothing to repeat".
    const sel = runSelection({
      repo: "/anywhere",
      diffText: DIFF,
      graphPath: FIXTURE,
      minDensity: 0,
      ignore: ["openspec/**"],
    });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    const reason = sel.reasons[0];
    expect(reason?.kind).toBe("invalid-ignore-pattern");
    if (reason?.kind !== "invalid-ignore-pattern") return;
    expect(reason.pattern).toBe("openspec/**");
    // The graph is readable here; the old code reported graph-unavailable.
    expect(sel.reasons.some((r) => r.kind === "graph-unavailable")).toBe(false);
  });

  it("rejects a bad ignore pattern even when the graph is unreadable", () => {
    // Pattern validation precedes graph loading, so the operator error wins.
    const sel = runSelection({
      repo: "/anywhere",
      diffText: DIFF,
      graphPath: "/nope/graph.json",
      ignore: ["["],
    });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("invalid-ignore-pattern");
  });
});
