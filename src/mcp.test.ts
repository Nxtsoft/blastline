import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleRequest } from "./mcp.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

const DIFF = `diff --git a/src/lib.ts b/src/lib.ts
index 1..2 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -9,0 +10,1 @@
+  x();
`;

function call(name: string, args: Record<string, unknown>) {
  return handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("MCP handleRequest", () => {
  it("answers initialize with the protocol version and tool capability", () => {
    const resp = handleRequest({ jsonrpc: "2.0", id: 0, method: "initialize" });
    expect(resp).toMatchObject({
      id: 0,
      result: { protocolVersion: "2024-11-05", serverInfo: { name: "blastline" } },
    });
  });

  it("ignores the initialized notification", () => {
    expect(handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("lists both tools with schemas", () => {
    const resp = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (resp as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["blastline_tests", "blastline_blast"]);
  });

  it("blastline_tests returns the impacted subset for a diff", () => {
    const resp = call("blastline_tests", {
      repo: "/anywhere",
      diff: DIFF,
      graph_path: FIXTURE,
      min_density: 0,
    });
    const text = (resp as { result: { content: { text: string }[] } }).result.content[0]!.text;
    expect(JSON.parse(text)).toEqual({ kind: "subset", tests: ["/repo/src/lib.test.ts"] });
  });

  it("blastline_blast returns dependents, not tests", () => {
    const resp = call("blastline_blast", {
      repo: "/anywhere",
      diff: DIFF,
      graph_path: FIXTURE,
      min_density: 0,
    });
    const parsed = JSON.parse(
      (resp as { result: { content: { text: string }[] } }).result.content[0]!.text,
    );
    expect(parsed.kind).toBe("subset");
    expect(parsed.blast.join("\n")).toContain("function use");
    expect(parsed.tests).toBeUndefined();
  });

  it("reports fail-open selections as data, not protocol errors", () => {
    const resp = call("blastline_tests", { repo: "/anywhere", diff: DIFF, graph_path: "/nope.json" });
    const parsed = JSON.parse(
      (resp as { result: { content: { text: string }[] } }).result.content[0]!.text,
    );
    expect(parsed.kind).toBe("all");
    expect(parsed.reasons[0].kind).toBe("graph-unavailable");
  });

  it("flags missing repo and unknown tools as tool errors", () => {
    const bad = call("blastline_tests", {}) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
    const unknown = call("nope", { repo: "/x" }) as { result: { isError: boolean } };
    expect(unknown.result.isError).toBe(true);
  });

  it("returns method-not-found for unknown requests but ignores unknown notifications", () => {
    const resp = handleRequest({ jsonrpc: "2.0", id: 9, method: "bogus/method" });
    expect(resp).toMatchObject({ error: { code: -32601 } });
    expect(handleRequest({ jsonrpc: "2.0", method: "bogus/notification" })).toBeNull();
  });
});
