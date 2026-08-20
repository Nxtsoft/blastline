import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraph, nodesInFile } from "./graph.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

describe("loadGraph / nodesInFile", () => {
  const g = loadGraph(FIXTURE);

  it("indexes incoming edges by target, with the relation", () => {
    // fn_parse is depended on by its caller, its test, and its containing file.
    expect(new Set(g.incoming.get("fn_parse")?.map((e) => e.from))).toEqual(
      new Set(["fn_use", "f_test", "f_lib"]),
    );
    expect(g.incoming.get("fn_parse")?.find((e) => e.from === "fn_use")?.relation).toBe("CALLS");
  });

  it("resolves repo-relative paths only at path boundaries", () => {
    expect(nodesInFile(g, "src/lib.ts").map((n) => n.id)).toContain("fn_parse");
    // "ib.ts" is a suffix of the string but not a path component — must not match.
    expect(nodesInFile(g, "ib.ts")).toEqual([]);
  });


  it("parses the content-root metadata when present and well-formed", () => {
    expect(g.contentRoot).toEqual({ algorithm: "sha256-merkle-v1", sha256: "a".repeat(64), leafCount: 5 });
  });
  it("returns empty for unknown files", () => {
    expect(nodesInFile(g, "src/nope.ts")).toEqual([]);
  });
});
