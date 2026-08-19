#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderComment } from "./comment.js";
import { loadGraph } from "./graph.js";
import { fileMtimeMs, select } from "./select.js";
import type { Selection } from "./types.js";

const USAGE = `blastline — graph-backed test impact and blast radius (built on CGraph)

usage:
  blastline tests <base>..<head> [options]     list test files impacted by the diff
  blastline blast <base>..<head> [options]     list transitive dependents of the diff
  blastline comment <base>..<head> [options]   render the selection as PR-comment markdown

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
if (command !== "tests" && command !== "blast" && command !== "comment")
  fail(`blastline: unknown command "${command}"\n\n${USAGE}`);

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}
function optAll(name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
  });
  return out;
}

const repo = resolve(opt("repo") ?? process.cwd());
const range = argv.slice(1).find((a) => a.includes("..") && !a.startsWith("--"));
const diffFile = opt("diff-file");
if (!range && !diffFile) fail("blastline: provide <base>..<head> or --diff-file\n\n" + USAGE);

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const diffText = diffFile ? readFileSync(diffFile, "utf8") : git("diff", "--unified=0", range as string);

const graphPath = opt("graph") ?? resolve(repo, "cgraph-out/graph.json");
const ignoreRegexes = optAll("ignore").map((p) => new RegExp(p));
const maxFilesRaw = opt("max-files");
const minDensityRaw = opt("min-density");

let selection: Selection;
try {
  const graph = loadGraph(graphPath);
  const baseGraphPath = opt("base-graph");
  const baseGraph = baseGraphPath ? loadGraph(baseGraphPath) : undefined;

  let headCommitMs: number | undefined;
  if (!diffFile && range) {
    const head = range.split("..").pop() as string;
    headCommitMs = Number(git("log", "-1", "--format=%ct", head).trim()) * 1000;
  }

  selection = select(diffText, {
    graph,
    ...(baseGraph !== undefined && { baseGraph }),
    ...(ignoreRegexes.length > 0 && { ignore: (p: string) => ignoreRegexes.some((r) => r.test(p)) }),
    ...(maxFilesRaw !== undefined && { maxFiles: Number(maxFilesRaw) }),
    ...(minDensityRaw !== undefined && { minDensity: Number(minDensityRaw) }),
    ...(fileMtimeMs(graphPath) !== undefined && { graphMtimeMs: fileMtimeMs(graphPath) as number }),
    ...(headCommitMs !== undefined && { headCommitMs }),
  });
} catch (e) {
  selection = {
    kind: "all",
    reasons: [
      { kind: "graph-unavailable", detail: `cannot load graph at ${graphPath}: ${(e as Error).message}` },
    ],
  };
}

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
