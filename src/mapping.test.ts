import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraph } from "./graph.js";
import { mapDiffToSeeds } from "./mapping.js";
import type { ChangedFile } from "./types.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));
const g = loadGraph(FIXTURE);

const change = (path: string, start: number, end: number, deletion = false): ChangedFile => ({
  path,
  oldPath: path,
  status: "modified",
  ranges: [{ start, end, deletion }],
});

describe("mapDiffToSeeds", () => {
  it("picks the innermost symbol per line", () => {
    // Line 10 sits inside both parse [3-20] and innerHelper [8-12].
    const { seeds, failOpen } = mapDiffToSeeds(g, [change("src/lib.ts", 10, 10)]);
    expect(failOpen).toEqual([]);
    expect(seeds).toEqual(new Set(["fn_inner"]));
  });

  it("seeds every symbol for a whole-file range (spike defect regression)", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 1, 30)]);
    expect(seeds).toContain("fn_parse");
    expect(seeds).toContain("fn_inner");
    expect(seeds).toContain("fn_other");
    expect(seeds).toContain("f_lib"); // lines 1-2 and 21 fall outside symbols
  });

  it("falls back to the file node for lines outside every symbol span", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 21, 21)]);
    expect(seeds).toEqual(new Set(["f_lib"]));
  });

  it("fails open on files with no graph node", () => {
    const { seeds, failOpen } = mapDiffToSeeds(g, [change("README.md", 1, 5)]);
    expect(seeds.size).toBe(0);
    expect(failOpen).toEqual([{ kind: "unmapped-file", path: "README.md" }]);
  });

  it("skips ignored files entirely instead of failing open", () => {
    const { seeds, failOpen } = mapDiffToSeeds(g, [change("README.md", 1, 5)], {
      ignore: (p) => p.endsWith(".md"),
    });
    expect(seeds.size).toBe(0);
    expect(failOpen).toEqual([]);
  });

  it("maps pure deletions via the base graph when supplied", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 9, 9, true)], { baseGraph: g });
    expect(seeds).toEqual(new Set(["fn_inner"]));
  });

  it("degrades pure deletions to the head file node without a base graph", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 9, 9, true)]);
    // Old-side line numbers are meaningless against the head graph; the file
    // node is the documented superset-safe approximation.
    expect(seeds).toEqual(new Set(["f_lib"]));
  });

  it("seeds all base symbols for a deleted file, and fails open without them", () => {
    const deleted: ChangedFile = {
      path: "src/lib.ts",
      oldPath: "src/lib.ts",
      status: "deleted",
      ranges: [{ start: 1, end: 30, deletion: true }],
    };
    const withBase = mapDiffToSeeds(g, [deleted], { baseGraph: g });
    expect(withBase.seeds).toContain("fn_parse");
    expect(withBase.seeds).toContain("fn_other");
    const withoutBase = mapDiffToSeeds(g, [deleted]);
    expect(withoutBase.failOpen).toEqual([{ kind: "unmapped-file", path: "src/lib.ts" }]);
  });
});
