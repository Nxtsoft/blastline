import { describe, expect, it } from "vitest";
import { checkCallers } from "./check.js";
import { indexGraph, resolveSymbol } from "./graph.js";

// mem.rs: poll_read_internal (248-300, the changed symbol) is called by
// poll_read (341-360), which is called by read_wrapper in util.rs. An impl
// block (240-400) also spans line 250 — the smallest-containing rule must pick
// the function, not the block. Two `helper`s make a bare label ambiguous.
const graph = indexGraph(
  [
    { id: "file_mem", label: "mem.rs", type: "file", source_file: "/r/src/mem.rs" },
    { id: "impl_block", label: "impl SimplexStream", type: "impl", source_file: "/r/src/mem.rs", source_location: { start_line: 240, end_line: 400 } },
    { id: "fn_internal", label: "poll_read_internal", type: "function", source_file: "/r/src/mem.rs", source_location: { start_line: 248, end_line: 300 } },
    { id: "fn_pollread", label: "poll_read", type: "function", source_file: "/r/src/mem.rs", source_location: { start_line: 341, end_line: 360 } },
    { id: "fn_wrapper", label: "read_wrapper", type: "function", source_file: "/r/src/util.rs", source_location: { start_line: 10, end_line: 20 } },
    { id: "helper_a", label: "helper", type: "function", source_file: "/r/src/a.rs", source_location: { start_line: 1, end_line: 5 } },
    { id: "helper_b", label: "helper", type: "function", source_file: "/r/src/b.rs", source_location: { start_line: 1, end_line: 5 } },
  ],
  [
    { source: "file_mem", target: "fn_internal", relation: "contains" },
    { source: "fn_pollread", target: "fn_internal", relation: "CALLS" },
    { source: "fn_wrapper", target: "fn_pollread", relation: "CALLS" },
  ],
);

describe("resolveSymbol", () => {
  it("resolves file:line to the smallest containing symbol (not the impl block)", () => {
    const r = resolveSymbol(graph, "src/mem.rs:250");
    expect(r).toEqual({ kind: "resolved", node: expect.objectContaining({ id: "fn_internal" }) });
  });

  it("resolves file:label", () => {
    const r = resolveSymbol(graph, "src/mem.rs:poll_read");
    expect(r).toEqual({ kind: "resolved", node: expect.objectContaining({ id: "fn_pollread" }) });
  });

  it("reports a bare label matching multiple nodes as ambiguous, never guesses", () => {
    const r = resolveSymbol(graph, "helper");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.nodes.map((n) => n.id).sort()).toEqual(["helper_a", "helper_b"]);
  });

  it("returns not-found for an unknown reference", () => {
    expect(resolveSymbol(graph, "src/mem.rs:9999").kind).toBe("not-found");
    expect(resolveSymbol(graph, "nope").kind).toBe("not-found");
  });
});

describe("checkCallers", () => {
  it("lists direct callers and refutes a no-other-callers claim", () => {
    const r = checkCallers({ graph, symbol: "src/mem.rs:250" });
    expect(r.kind).toBe("checked");
    if (r.kind !== "checked") return;
    expect(r.verdict).toBe("refuted");
    expect(r.callers.map((c) => c.id)).toEqual(["fn_pollread"]);
    expect(r.callers[0]).toMatchObject({ label: "poll_read", relation: "CALLS", file: "/r/src/mem.rs" });
    expect(r.caveat).toBeUndefined();
  });

  it("--exclude of the only caller yields no-static-callers WITH the caveat", () => {
    const r = checkCallers({ graph, symbol: "src/mem.rs:250", exclude: ["src/mem.rs:poll_read"] });
    expect(r.kind).toBe("checked");
    if (r.kind !== "checked") return;
    expect(r.verdict).toBe("no-static-callers");
    expect(r.callers).toEqual([]);
    expect(r.excluded.map((c) => c.id)).toEqual(["fn_pollread"]);
    // the refuter-not-certifier caveat is mandatory on an empty result
    expect(r.caveat).toMatch(/NOT a certificate/i);
  });

  it("never emits certification wording on any result", () => {
    for (const sym of ["src/mem.rs:250", "src/mem.rs:poll_read"]) {
      const r = checkCallers({ graph, symbol: sym, exclude: ["src/mem.rs:poll_read", "src/util.rs:read_wrapper"] });
      const text = JSON.stringify(r).toLowerCase();
      expect(text).not.toContain("safe to delete");
      expect(text).not.toContain("safe to remove");
    }
  });

  it("excludes the containing file (`contains` edge) from direct callers", () => {
    const r = checkCallers({ graph, symbol: "src/mem.rs:250" });
    expect(r.kind).toBe("checked");
    if (r.kind !== "checked") return;
    // file_mem contains fn_internal, but the declaring file is not a caller
    expect(r.callers.map((c) => c.id)).not.toContain("file_mem");
    expect(r.callers.map((c) => c.id)).toEqual(["fn_pollread"]);
  });

  it("--transitive walks the full blast radius (dependents parity, incl. declaring file)", () => {
    const r = checkCallers({ graph, symbol: "src/mem.rs:250", transitive: true });
    expect(r.kind).toBe("checked");
    if (r.kind !== "checked") return;
    // transitive === the `blast` semantics: every transitive dependent, which
    // reaches read_wrapper through poll_read and includes the declaring file.
    expect(r.callers.map((c) => c.id).sort()).toEqual(["file_mem", "fn_pollread", "fn_wrapper"]);
  });

  it("fails open on symbol-not-found and on symbol-ambiguous", () => {
    expect(checkCallers({ graph, symbol: "nope" })).toEqual({
      kind: "fail-open",
      reasons: [{ kind: "symbol-not-found", symbol: "nope" }],
    });
    const amb = checkCallers({ graph, symbol: "helper" });
    expect(amb.kind).toBe("fail-open");
    if (amb.kind === "fail-open") expect(amb.reasons[0]).toMatchObject({ kind: "symbol-ambiguous" });
  });

  it("propagates freshness fail-open reasons without querying", () => {
    const r = checkCallers({
      graph,
      symbol: "src/mem.rs:250",
      reasons: [{ kind: "stale-graph", expected: "e", actual: "a" }],
    });
    expect(r).toEqual({ kind: "fail-open", reasons: [{ kind: "stale-graph", expected: "e", actual: "a" }] });
  });

  it("is deterministic across two identical runs", () => {
    const a = checkCallers({ graph, symbol: "src/mem.rs:250", transitive: true });
    const b = checkCallers({ graph, symbol: "src/mem.rs:250", transitive: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
