import { createInterface } from "node:readline";
import { runCheck } from "./check.js";
import { runSelection } from "./run.js";

/**
 * Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 implementing
 * initialize, tools/list, and tools/call — the same protocol surface CGraph's
 * own MCP server speaks (protocol 2024-11-05).
 */

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "absolute path to the repository" },
    range: { type: "string", description: "git range <base>..<head>" },
    diff: { type: "string", description: "unified-0 diff text (alternative to range)" },
    graph_path: { type: "string", description: "CGraph graph.json for head (default <repo>/cgraph-out/graph.json)" },
    base_graph_path: { type: "string", description: "graph.json for base — improves deletion mapping" },
    ignore: { type: "array", items: { type: "string" }, description: "regexes for paths declared irrelevant" },
    min_density: { type: "number", description: "edges-per-file floor (default 3)" },
    min_test_reachability: { type: "number", description: "test-reachability floor, 0-1 (default 0.25)" },
    expected_content_root: { type: "string", description: "pin to this sha256-merkle-v1 content root; mismatch fails open" },
    daemon_verify: { type: "boolean", description: "pin against the live CGraph daemon's content root" },
    max_files: { type: "number", description: "fail open above this many changed files (default 200)" },
  },
  required: ["repo"],
} as const;

const CHECK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "absolute path to the repository" },
    symbol: { type: "string", description: "subject symbol: file:line | file:label | bare label" },
    exclude: { type: "array", items: { type: "string" }, description: "callers you are already updating (asks 'no OTHER callers')" },
    transitive: { type: "boolean", description: "walk transitive dependents instead of just direct callers" },
    graph_path: { type: "string", description: "CGraph graph.json for head (default <repo>/cgraph-out/graph.json)" },
    expected_content_root: { type: "string", description: "pin to this sha256-merkle-v1 content root; mismatch fails open" },
    daemon_verify: { type: "boolean", description: "pin against the live CGraph daemon's content root" },
  },
  required: ["repo", "symbol"],
} as const;

const TOOLS = [
  {
    name: "blastline_tests",
    description:
      "List the test files impacted by a diff, from the CGraph code graph. " +
      "Selection is a safe superset ('run at least these'); kind=all means run the full suite, with reasons.",
    inputSchema: TOOL_INPUT_SCHEMA,
  },
  {
    name: "blastline_blast",
    description:
      "List the transitive dependents (blast radius) of a diff, with file:line, from the CGraph code graph. " +
      "Use before editing to see what a change reaches.",
    inputSchema: TOOL_INPUT_SCHEMA,
  },
  {
    name: "blastline_check",
    description:
      "REFUTES, does not certify. Before you refactor/rename/delete a symbol, list what statically references it. " +
      "verdict=refuted means callers exist beyond your --exclude set (authoritative — update them). " +
      "verdict=no-static-callers is NOT 'safe to delete': dynamic dispatch, reflection, and macros are invisible to the graph.",
    inputSchema: CHECK_INPUT_SCHEMA,
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } };

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== "blastline_tests" && name !== "blastline_blast" && name !== "blastline_check") {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  if (typeof args["repo"] !== "string") {
    return { content: [{ type: "text", text: "repo (string) is required" }], isError: true };
  }
  if (name === "blastline_check") {
    if (typeof args["symbol"] !== "string") {
      return { content: [{ type: "text", text: "symbol (string) is required" }], isError: true };
    }
    const result = runCheck({
      repo: args["repo"],
      symbol: args["symbol"],
      ...(Array.isArray(args["exclude"]) && { exclude: args["exclude"] as string[] }),
      ...(args["transitive"] === true && { transitive: true }),
      ...(typeof args["graph_path"] === "string" && { graphPath: args["graph_path"] }),
      ...(typeof args["expected_content_root"] === "string" && { expectedContentRoot: args["expected_content_root"] }),
      ...(args["daemon_verify"] === true && { daemonVerify: true }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  const selection = runSelection({
    repo: args["repo"],
    ...(typeof args["range"] === "string" && { range: args["range"] }),
    ...(typeof args["diff"] === "string" && { diffText: args["diff"] }),
    ...(typeof args["graph_path"] === "string" && { graphPath: args["graph_path"] }),
    ...(typeof args["base_graph_path"] === "string" && { baseGraphPath: args["base_graph_path"] }),
    ...(Array.isArray(args["ignore"]) && { ignore: args["ignore"] as string[] }),
    ...(typeof args["min_density"] === "number" && { minDensity: args["min_density"] }),
    ...(typeof args["min_test_reachability"] === "number" && { minTestReachability: args["min_test_reachability"] }),
    ...(typeof args["expected_content_root"] === "string" && { expectedContentRoot: args["expected_content_root"] }),
    ...(args["daemon_verify"] === true && { daemonVerify: true }),
    ...(typeof args["max_files"] === "number" && { maxFiles: args["max_files"] }),
  });
  const payload =
    selection.kind === "all"
      ? { kind: "all", reasons: selection.reasons }
      : name === "blastline_tests"
        ? { kind: "subset", tests: selection.tests, ...(selection.contentRoot !== undefined && { content_root: selection.contentRoot }) }
        : { kind: "subset", blast: selection.blast, ...(selection.contentRoot !== undefined && { content_root: selection.contentRoot }) };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Handle one JSON-RPC message; returns null for notifications (no reply). */
export function handleRequest(req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "blastline", version: "0.4.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const params = req.params ?? {};
      const name = params["name"];
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "tools/call requires params.name" } };
      }
      return ok(id, callTool(name, args));
    }
    default:
      if (req.id === undefined) return null; // unknown notification: ignore
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}

/** stdio loop: one JSON-RPC message per line in, one per line out. */
export function serveStdio(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let response: JsonRpcResponse | null;
    try {
      response = handleRequest(JSON.parse(trimmed) as JsonRpcRequest);
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
