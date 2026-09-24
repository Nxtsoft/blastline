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
});
