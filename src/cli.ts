#!/usr/bin/env node
import { runCheck } from "./check.js";
import { renderComment } from "./comment.js";
import { serveStdio } from "./mcp.js";
import { runSelection } from "./run.js";

const USAGE = `blastline — graph-backed test impact and blast radius (built on CGraph)

usage:
  blastline tests <base>..<head> [options]     list test files impacted by the diff
  blastline blast <base>..<head> [options]     list transitive dependents of the diff
  blastline comment <base>..<head> [options]   render the selection as PR-comment markdown
  blastline check callers <symbol> [options]   list what references a symbol (pre-edit check)
  blastline mcp                                serve the MCP tools (blastline_tests, blastline_blast, blastline_check) over stdio

check options:
  <symbol>             file:line | file:label | bare label
  --exclude <symbol>   a caller you are already updating (repeatable) — asks "no OTHER callers"
  --transitive         walk transitive dependents, not just direct callers
  check refutes claims, it never certifies: callers found is authoritative; no
  callers found is "no-static-callers", NOT "safe to delete" (dynamic dispatch,
  reflection, and macros are invisible to the graph).

options:
  --repo <path>        repository to diff (default: cwd)
  --graph <path>       CGraph graph.json for head (default: <repo>/cgraph-out/graph.json)
  --base-graph <path>  graph.json for base — improves pure-deletion mapping
  --diff-file <path>   read a unified-0 diff from a file instead of running git
  --ignore <regex>     repo-relative paths declared irrelevant (repeatable)
  --max-files <n>      fail open when the diff touches more files (default 200)
  --min-density <n>    fail open below this edges-per-file floor (default 3)
  --min-test-reachability <f>  fail open when tests reach under this fraction of code (default 0.25)
  --expect-root <sha256>  pin the selection to this content root (fail open on mismatch)
  --daemon-verify      pin against the live CGraph daemon's content root (cgraph-client status)
  --json               structured output

Selection is a safe superset: "run at least these." Any file the graph cannot
vouch for fails open to ALL, with the reason printed. Subsets carry the graph's
sha256-merkle-v1 content root as provenance; pin with --expect-root or
--daemon-verify (a graph older than the head commit also fails open as stale).`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
const command = argv[0];
if (command === undefined || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(0);
}
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const optAll = (name: string): string[] => {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
  });
  return out;
};

if (command === "mcp") {
  serveStdio();
} else if (command === "check") {
  const claim = argv[1];
  if (claim !== "callers") fail(`blastline: unknown check claim "${claim ?? ""}" (only "callers")\n\n${USAGE}`);
  // The subject symbol is the first positional after the claim that is not a flag
  // or a flag value.
  const flagValues = new Set<string>();
  argv.forEach((a, i) => {
    if (a === "--exclude" || a === "--repo" || a === "--graph" || a === "--expect-root") {
      if (argv[i + 1] !== undefined) flagValues.add(argv[i + 1] as string);
    }
  });
  const symbol = argv.slice(2).find((a) => !a.startsWith("--") && !flagValues.has(a));
  if (!symbol) fail("blastline: provide a symbol (file:line | file:label | label)\n\n" + USAGE);
  const result = runCheck({
    repo: opt("repo") ?? process.cwd(),
    symbol,
    exclude: optAll("exclude"),
    ...(argv.includes("--transitive") && { transitive: true }),
    ...(opt("graph") !== undefined && { graphPath: opt("graph") as string }),
    ...(opt("expect-root") !== undefined && { expectedContentRoot: opt("expect-root") as string }),
    ...(argv.includes("--daemon-verify") && { daemonVerify: true }),
  });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (result.kind === "fail-open") {
    console.log("UNVERIFIED");
    for (const r of result.reasons) console.error(`fail-open: ${JSON.stringify(r)}`);
    process.exit(0);
  }
  console.log(`verdict: ${result.verdict}`);
  if (result.verdict === "no-static-callers") console.error(result.caveat);
  for (const c of result.callers) {
    const loc = c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : "";
    console.log(`${c.relation} ${c.kind} ${c.label}${loc}`);
  }
  process.exit(0);
} else {
  if (command !== "tests" && command !== "blast" && command !== "comment")
    fail(`blastline: unknown command "${command}"\n\n${USAGE}`);

  const range = argv.slice(1).find((a) => a.includes("..") && !a.startsWith("--"));
  const diffFile = opt("diff-file");
  if (!range && !diffFile) fail("blastline: provide <base>..<head> or --diff-file\n\n" + USAGE);

  const maxFilesRaw = opt("max-files");
  const minDensityRaw = opt("min-density");
  const minReachRaw = opt("min-test-reachability");
  const expectRoot = opt("expect-root");
  const selection = runSelection({
    repo: opt("repo") ?? process.cwd(),
    ...(range !== undefined && { range }),
    ...(diffFile !== undefined && { diffFile }),
    ...(opt("graph") !== undefined && { graphPath: opt("graph") as string }),
    ...(opt("base-graph") !== undefined && { baseGraphPath: opt("base-graph") as string }),
    ignore: optAll("ignore"),
    ...(maxFilesRaw !== undefined && { maxFiles: Number(maxFilesRaw) }),
    ...(minDensityRaw !== undefined && { minDensity: Number(minDensityRaw) }),
    ...(minReachRaw !== undefined && { minTestReachability: Number(minReachRaw) }),
    ...(expectRoot !== undefined && { expectedContentRoot: expectRoot }),
    ...(argv.includes("--daemon-verify") && { daemonVerify: true }),
  });

  if (command === "comment") {
    console.log(renderComment(selection, range ?? diffFile ?? ""));
    process.exit(0);
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(selection, null, 2));
    process.exit(0);
  }
  if (selection.kind === "all") {
    console.log("ALL");
    for (const r of selection.reasons) console.error(`fail-open: ${JSON.stringify(r)}`);
    process.exit(0);
  }
  const lines = command === "tests" ? selection.tests : selection.blast;
  for (const line of lines) console.log(line);
}
