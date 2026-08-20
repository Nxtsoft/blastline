import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexGraph, loadGraph } from "./graph.js";
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

  it("the dispatch barrier: contract callers are affected, sibling implementers are not", () => {
    // The gorilla/mux shape that inflated Go subsets to 45.9%: two types
    // implement one interface; changing ONE implementation must reach the
    // contract's CALLERS but not the interface's structural neighborhood
    // (the sibling implementer, its methods, and their callers).
    const node = (id: string) => ({ id, label: id, type: "function", source_file: `/r/${id}.go` });
    const graph = indexGraph(
      ["route_match", "iface_match", "iface", "router", "router_get", "get_caller", "contract_caller", "outer_caller"].map(node),
      [
        // contract wiring (as CGraph emits it)
        { source: "iface", target: "iface_match", relation: "method" },
        { source: "iface_match", target: "route_match", relation: "dispatches_to" },
        { source: "router", target: "iface", relation: "implements" },
        { source: "router_get", target: "router", relation: "method_of" },
        // consumers
        { source: "contract_caller", target: "iface_match", relation: "CALLS" },
        { source: "outer_caller", target: "contract_caller", relation: "CALLS" },
        { source: "get_caller", target: "router_get", relation: "CALLS" },
      ],
    );
    const out = dependents(graph, ["route_match"]);
    // Affected: the contract node (as a call target) and its real consumers.
    expect(out).toContain("iface_match");
    expect(out).toContain("contract_caller");
    expect(out).toContain("outer_caller");
    // Not affected: the interface declaration, the sibling implementer, its
    // method surface, and callers that never touch the changed code.
    expect(out).not.toContain("iface");
    expect(out).not.toContain("router");
    expect(out).not.toContain("router_get");
    expect(out).not.toContain("get_caller");
  });

  it("an edited contract node itself still expands structurally", () => {
    // When the interface METHOD is the seed (its declaration changed), the
    // barrier must not apply: implementers genuinely depend on the contract.
    const node = (id: string) => ({ id, label: id, type: "function", source_file: `/r/${id}.go` });
    const graph = indexGraph(
      ["iface_match", "iface", "router"].map(node),
      [
        { source: "iface", target: "iface_match", relation: "method" },
        { source: "router", target: "iface", relation: "implements" },
      ],
    );
    const out = dependents(graph, ["iface_match"]);
    expect(out).toContain("iface");
    expect(out).toContain("router");
  });
});
