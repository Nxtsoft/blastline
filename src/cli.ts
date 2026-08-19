#!/usr/bin/env node
import { renderComment } from "./comment.js";
import { serveStdio } from "./mcp.js";
import { runSelection } from "./run.js";

const USAGE = `blastline — graph-backed test impact and blast radius (built on CGraph)

usage:
  blastline tests <base>..<head> [options]     list test files impacted by the diff
  blastline blast <base>..<head> [options]     list transitive dependents of the diff
  blastline comment <base>..<head> [options]   render the selection as PR-comment markdown
  blastline mcp                                serve the MCP tools (blastline_tests, blastline_blast) over stdio

options:
  --repo <path>        repository to diff (default: cwd)
  --graph <path>       CGraph graph.json for head (default: <repo>/cgraph-out/graph.json)
  --base-graph <path>  graph.json for base — improves pure-deletion mapping
  --diff-file <path>   read a unified-0 diff from a file instead of running git
  --ignore <regex>     repo-relative paths declared irrelevant (repeatable)
  --max-files <n>      fail open when the diff touches more files (default 200)
  --min-density <n>    fail open below this edges-per-file floor (default 3)
  --json               structured output

Selection is a safe superset: "run at least these." Any file the graph cannot
vouch for fails open to ALL, with the reason printed. One-shot graphs cannot be
freshness-pinned (daemon pinning is planned); a graph older than the head
commit fails open as stale.`;

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
if (command === "mcp") {
  serveStdio();
} else {
  if (command !== "tests" && command !== "blast" && command !== "comment")
    fail(`blastline: unknown command "${command}"\n\n${USAGE}`);

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

  const range = argv.slice(1).find((a) => a.includes("..") && !a.startsWith("--"));
  const diffFile = opt("diff-file");
  if (!range && !diffFile) fail("blastline: provide <base>..<head> or --diff-file\n\n" + USAGE);

  const maxFilesRaw = opt("max-files");
  const minDensityRaw = opt("min-density");
  const selection = runSelection({
    repo: opt("repo") ?? process.cwd(),
    ...(range !== undefined && { range }),
    ...(diffFile !== undefined && { diffFile }),
    ...(opt("graph") !== undefined && { graphPath: opt("graph") as string }),
    ...(opt("base-graph") !== undefined && { baseGraphPath: opt("base-graph") as string }),
    ignore: optAll("ignore"),
    ...(maxFilesRaw !== undefined && { maxFiles: Number(maxFilesRaw) }),
    ...(minDensityRaw !== undefined && { minDensity: Number(minDensityRaw) }),
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
