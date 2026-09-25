import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DEFAULT_SESSIONS_DB } from "./sessions.js";
import { buildBrief, othersIn, reviewsIn } from "./brief.js";
import { runCheck } from "./check.js";
import { renderBrief, renderCheckRun } from "./comment.js";
import { runSelection } from "./run.js";
import type { RunOptions } from "./run.js";

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

const BRIEF_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ...TOOL_INPUT_SCHEMA.properties,
    range: { type: "string", description: "git range <base>..<head> (required: the brief lists its commits)" },
    change_context: { type: "string", description: "path to cgraph change-context JSON: symbol changes and removed-symbol claims" },
    previous: { type: "string", description: "path to the previously posted comment; its embedded snapshot gives the since-push delta" },
    others: { type: "array", items: { type: "object", properties: { number: { type: "number" }, body: { type: "string" } } }, description: "the other open PRs' brief comments; the Concurrent PRs row names the ones that meet this PR's changes or reach" },
    author: { type: "string", description: "the PR author's login; with reviews, the Reviewed-by row says whether anyone else has looked" },
    reviews: { type: "array", items: { type: "object", properties: { login: { type: "string" }, state: { type: "string" } } }, description: "the PR's reviews (login, state), any order" },
    narrative: { type: "string", description: "the PR body text, checked with each commit message against the diff: phantom names in code font, changed code never named, placeholder text" },
    annotations: { type: "number", description: "check-run annotations on the highest-reach changed lines (default and ceiling 50)" },
    head_sha: { type: "string", description: "commit to name as the head in links and the check run when the range ends elsewhere" },
    local: { type: "boolean", description: "on the agent machine: commits without a checkpoint ref take their intent from the fleet session index (~/.agents/.history/sessions/sessions.db); nothing leaves the machine" },
    sessions_db: { type: "string", description: "with local: the index to read instead of the default path" },
    repo_url: { type: "string", description: "https://github.com/<owner>/<repo>: paths become blob links" },
    pr: { type: "number", description: "pull request number, shown in the summary" },
  },
  required: ["repo", "range"],
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
  {
    name: "blastline_brief",
    description:
      "The PR brief for a range, before you push it: what each commit did (from its Entire checkpoint: first prompt line, " +
      "agent, model, files touched, test commands run; never the transcript), symbol changes from cgraph change-context, " +
      "reach, and claims checked against the graph and the diff (refuted | partial | consistent, never verified), " +
      "including the narrative's: a name in code font the diff does not carry, changed code it never names, placeholder text. " +
      "Returns {brief, markdown, check_run}; check_run is the Checks API body the Action posts.",
    inputSchema: BRIEF_INPUT_SCHEMA,
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

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function selectionOptions(repo: string, args: Record<string, unknown>): RunOptions {
  return {
    repo,
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
  };
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== "blastline_tests" && name !== "blastline_blast" && name !== "blastline_check" && name !== "blastline_brief") {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  if (typeof args["repo"] !== "string") {
    return { content: [{ type: "text", text: "repo (string) is required" }], isError: true };
  }
  if (name === "blastline_brief") {
    if (typeof args["range"] !== "string") {
      return { content: [{ type: "text", text: "range (string) is required" }], isError: true };
    }
    const brief = buildBrief({
      ...selectionOptions(args["repo"], args),
      range: args["range"],
      ...(typeof args["change_context"] === "string" && { changeContextFile: args["change_context"] }),
      ...(typeof args["previous"] === "string" && { previousFile: args["previous"] }),
      ...(Array.isArray(args["others"]) && { others: othersIn(JSON.stringify(args["others"])) }),
      ...(typeof args["author"] === "string" && { author: args["author"] }),
      ...(Array.isArray(args["reviews"]) && { reviews: reviewsIn(JSON.stringify(args["reviews"])) }),
      ...(typeof args["narrative"] === "string" && { narrative: args["narrative"] }),
      ...(typeof args["annotations"] === "number" && { annotations: args["annotations"] }),
      ...(typeof args["head_sha"] === "string" && { headSha: args["head_sha"] }),
      ...(args["local"] === true && { sessionsDb: typeof args["sessions_db"] === "string" ? args["sessions_db"] : DEFAULT_SESSIONS_DB }),
    });
    const headSha = brief.headSha;
    const markdown = renderBrief(brief, {
      range: args["range"],
      repo: args["repo"],
      version: VERSION,
      ...(brief.baseSha !== undefined && { baseSha: brief.baseSha }),
      ...(headSha !== undefined && { headSha }),
      ...(typeof args["repo_url"] === "string" && { repoUrl: args["repo_url"].replace(/\/$/, "") }),
      ...(typeof args["pr"] === "number" && { prNumber: args["pr"] }),
    });
    const payload = { brief, markdown, check_run: renderCheckRun(brief, markdown, headSha ?? brief.snapshot.head) };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
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
  const selection = runSelection(selectionOptions(args["repo"], args));
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
