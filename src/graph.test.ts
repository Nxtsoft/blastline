import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraph, nodesForPath } from "./graph.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

describe("loadGraph / nodesForPath", () => {
  const g = loadGraph(FIXTURE);

  it("indexes incoming edges by target", () => {
    // fn_parse is depended on by its caller, its test, and its containing file.
    expect(new Set(g.incoming.get("fn_parse"))).toEqual(new Set(["fn_use", "f_test", "f_lib"]));
  });

  it("resolves repo-relative paths only at path boundaries", () => {
    expect(nodesForPath(g, "src/lib.ts").map((n) => n.id)).toContain("fn_parse");
    // "ib.ts" is a suffix of the string but not a path component — must not match.
    expect(nodesForPath(g, "ib.ts")).toEqual([]);
  });

  it("returns empty for unknown files", () => {
    expect(nodesForPath(g, "src/nope.ts")).toEqual([]);
  });
});
