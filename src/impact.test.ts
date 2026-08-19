import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraph } from "./graph.js";
import { dependents } from "./impact.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));
const g = loadGraph(FIXTURE);

describe("dependents", () => {
  it("walks transitively across relation kinds", () => {
    // innerHelper <- parse (CALLS) <- use (CALLS), lib.test.ts (imports),
    // lib.ts (contains); lib.ts <- consumer/test (imports_from), index (re_exports);
    // use <- consumer.ts (contains).
    const out = dependents(g, ["fn_inner"]);
    expect(out).toEqual(
      new Set(["fn_parse", "fn_use", "f_test", "f_lib", "f_consumer", "f_index"]),
    );
  });

  it("excludes the seeds themselves", () => {
    expect(dependents(g, ["fn_parse"])).not.toContain("fn_parse");
  });

  it("returns nothing for a node with no dependents", () => {
    expect(dependents(g, ["f_free"])).toEqual(new Set());
  });
});
