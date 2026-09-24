import { describe, expect, it } from "vitest";
import { renderFigure } from "./figure.js";
import type { Selection } from "./types.js";

const REPO = "/r";

function selection(changed: number, reached: number, tests: number): Extract<Selection, { kind: "subset" }> {
  const c = Array.from({ length: changed }, (_, i) => `src/changed-${i}.ts`);
  const r = Array.from({ length: reached }, (_, i) => `/r/src/reached-${i}.ts`);
  const t = Array.from({ length: tests }, (_, i) => `/r/src/t-${i}.test.ts`);
  const edges = [
    ...c.flatMap((cf) => r.map((rf) => ({ from: `/r/${cf}`, to: rf }))),
    ...r.flatMap((rf) => t.map((tf) => ({ from: rf, to: tf }))),
  ];
  return {
    kind: "subset",
    tests: t,
    blast: [],
    testsTotal: 100,
    files: c.map((path) => ({
      path,
      status: "modified" as const,
      disposition: "mapped" as const,
      symbols: ["a", "b"],
      reaches: r.map((file) => ({ file, symbols: ["x"] })),
      tests: t,
    })),
    edges,
  };
}

describe("renderFigure", () => {
  it("draws one node per file in three columns with counts in the captions", () => {
    const svg = renderFigure(selection(2, 3, 4), { theme: "dark", repo: REPO }) as string;
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("CHANGED  2 files, 4 symbols");
    expect(svg).toContain("REACHES  3 files, 0 dependents");
    expect(svg).toContain("TESTS  4 of 100");
    expect((svg.match(/<rect x="\d+(\.\d+)?" y="[^"]+" width="(306|236|240)"/g) ?? []).length).toBe(9);
    // labels are repo-relative and drop the directory every shown file shares
    expect(svg).toContain(">reached-0.ts<");
    expect(svg).toContain("paths under src/ unless shown in full");
    expect(svg).not.toContain("/r/src/");
  });

  it("folds rows past the cap into a +N more node and routes their edges to it", () => {
    const svg = renderFigure(selection(1, 20, 2), { theme: "light", repo: REPO, maxRows: 5 }) as string;
    expect(svg).toContain(">+15 more<");
    expect(svg).not.toContain("reached-19.ts");
    // one edge from the changed file to the fold, not fifteen
    const toMore = (svg.match(/<path d="M342/g) ?? []).length;
    expect(toMore).toBe(6);
  });

  it("escapes labels so a path with angle brackets cannot break the SVG", () => {
    const sel = selection(1, 0, 1);
    sel.files[0]!.path = "src/<weird>&.ts";
    const svg = renderFigure(sel, { theme: "dark", repo: REPO }) as string;
    expect(svg).toContain("&lt;weird&gt;&amp;.ts");
    expect(svg).not.toContain("<weird>");
  });

  it("returns null for a fail-open selection", () => {
    expect(renderFigure({ kind: "all", reasons: [{ kind: "no-test-files" }] }, { theme: "dark", repo: REPO })).toBeNull();
  });

  // Seen live on turing-webapp PR 592: a workflow-only change, ignored by
  // policy, produced a 64px figure of three captions over nothing.
  it("returns null when no changed file was mapped", () => {
    const sel = selection(0, 0, 0);
    sel.files = [{ path: ".github/workflows/x.yml", status: "modified", disposition: "ignored", symbols: [], reaches: [], tests: [] }];
    expect(renderFigure(sel, { theme: "dark", repo: REPO })).toBeNull();
  });

  it("returns null when the only mapped files are the edited tests themselves", () => {
    const sel = selection(0, 0, 0);
    sel.tests = ["/r/src/a.test.ts"];
    sel.files = [{ path: "src/a.test.ts", status: "modified", disposition: "mapped", symbols: ["it"], reaches: [], tests: ["/r/src/a.test.ts"] }];
    expect(renderFigure(sel, { theme: "dark", repo: REPO })).toBeNull();
  });
});

// The reviewer's reproduction: a real selection over the mini fixture drew no
// changed node, because the changed file counted as reaching itself and the
// reached column overwrote it. The figure must draw the changed file exactly
// once, in the changed column.
describe("renderFigure over a real selection", () => {
  it("draws the changed file in the changed column and never in the reached column", async () => {
    const { fileURLToPath } = await import("node:url");
    const { loadGraph } = await import("./graph.js");
    const { select } = await import("./select.js");
    const g = loadGraph(fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url)));
    const diff = `diff --git a/src/lib.ts b/src/lib.ts
index 1..2 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -9,0 +10,1 @@
+  x();
`;
    const sel = select(diff, { graph: g, minDensity: 0 });
    if (sel.kind !== "subset") throw new Error("expected subset");
    expect(sel.files[0]!.reaches.map((r) => r.file)).not.toContain("/repo/src/lib.ts");
    const svg = renderFigure(sel, { theme: "dark", repo: "/repo" }) as string;
    const changedColumn = svg.match(/<rect x="36" y="[^"]+" width="306"/g) ?? [];
    expect(changedColumn.length).toBe(1);
    expect(svg).toContain("CHANGED  1 file");
    expect((svg.match(/>lib\.ts</g) ?? []).length).toBe(1);
  });

  // A pure rename has no hunk and so no seed, but it is still a changed file;
  // when another change reaches it, it must not be drawn in both columns.
  it("keeps a hunk-less changed file (a rename) in the changed column when another change reaches it", async () => {
    const { fileURLToPath } = await import("node:url");
    const { loadGraph } = await import("./graph.js");
    const { select } = await import("./select.js");
    const g = loadGraph(fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url)));
    const diff = `diff --git a/src/lib.ts b/src/lib.ts
index 1..2 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -9,0 +10,1 @@
+  x();
diff --git a/src/old-consumer.ts b/src/consumer.ts
similarity index 100%
rename from src/old-consumer.ts
rename to src/consumer.ts
`;
    const sel = select(diff, { graph: g, minDensity: 0 });
    if (sel.kind !== "subset") throw new Error("expected subset");
    expect(sel.files.map((f) => f.path)).toEqual(["src/lib.ts", "src/consumer.ts"]);
    expect(sel.files[0]!.reaches.map((r) => r.file)).not.toContain("/repo/src/consumer.ts");
    const svg = renderFigure(sel, { theme: "dark", repo: "/repo" }) as string;
    expect((svg.match(/<rect x="36" y="[^"]+" width="306"/g) ?? []).length).toBe(2);
    expect((svg.match(/>consumer\.ts</g) ?? []).length).toBe(1);
  });
});
