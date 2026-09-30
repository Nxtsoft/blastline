import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseUnifiedDiff } from "./diff.js";
import type { CodeGraph } from "./graph.js";
import { loadGraph, nodesInFile } from "./graph.js";
import type { PathVerdicts } from "./paths.js";
import { isDeliberatelyIgnored, loadPathVerdicts } from "./paths.js";
import type { Resolution } from "./references.js";
import { resolveReferences } from "./references.js";
import type { ScriptAddition } from "./manifest.js";
import { inertScriptAddition } from "./manifest.js";
import { fileMtimeMs, select } from "./select.js";
import type { Selection } from "./types.js";
import { unnamedFiles } from "./unnamed.js";

export interface RunOptions {
  repo: string;
  /** git range <base>..<head>; ignored when diffText/diffFile is given */
  range?: string;
  /** unified-0 diff text, supplied directly (MCP callers) */
  diffText?: string;
  /** path to a unified-0 diff file */
  diffFile?: string;
  graphPath?: string;
  baseGraphPath?: string;
  ignore?: string[];
  maxFiles?: number;
  maxSelectedFraction?: number;
  maxTraversalNodes?: number;
  minDensity?: number;
  minTestReachability?: number;
  /** pin the selection to this sha256-merkle-v1 content root */
  expectedContentRoot?: string;
  /**
   * Ask the repo's CGraph daemon (via cgraph-client status) for its live
   * content root and pin against it — the daemon watches the tree, so a match
   * proves the loaded graph corresponds to the working tree right now.
   */
  daemonVerify?: boolean;
}

/** The daemon's live content root, or an explanation of why it can't vouch. */
export function daemonContentRoot(repo: string): { root?: string; error?: string } {
  try {
    const out = execFileSync("cgraph-client", ["--root", repo, "status"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const status = JSON.parse(out) as {
      result?: { freshness?: { verified?: boolean; content_root?: string } };
    };
    const freshness = status.result?.freshness;
    if (freshness?.verified && typeof freshness.content_root === "string") {
      return { root: freshness.content_root };
    }
    return { error: "daemon status carries no verified content root" };
  } catch (e) {
    return { error: `cgraph-client status failed: ${(e as Error).message}` };
  }
}

/**
 * The one selection entry point shared by the CLI and the MCP server:
 * resolve the diff, load the graph(s), apply the freshness guard, select.
 * Never throws — an unreadable graph becomes a graph-unavailable fail-open, and
 * an unparseable --ignore pattern an invalid-ignore-pattern one.
 */
export function runSelection(o: RunOptions): Selection {
  const repo = resolve(o.repo);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  let diffText: string;
  if (o.diffText !== undefined) diffText = o.diffText;
  else if (o.diffFile !== undefined) diffText = readFileSync(o.diffFile, "utf8");
  else if (o.range !== undefined) diffText = git("diff", "--unified=0", o.range);
  else return { kind: "all", reasons: [{ kind: "graph-unavailable", detail: "no range, diff, or diff file given" }] };

  // Compiled before the graph-loading try: an unparseable --ignore pattern is
  // operator error, not a graph limitation, and must not be reported as one.
  const regexes: RegExp[] = [];
  for (const pattern of o.ignore ?? []) {
    try {
      regexes.push(new RegExp(pattern));
    } catch (e) {
      return {
        kind: "all",
        reasons: [{ kind: "invalid-ignore-pattern", pattern, detail: (e as Error).message }],
      };
    }
  }

  // The range's head when the diff came from git; a supplied diff has no tree.
  const head = o.diffText === undefined && o.diffFile === undefined && o.range !== undefined ? (o.range.split("..").pop() as string) : undefined;
  const graphPath = o.graphPath ?? resolve(repo, "cgraph-out/graph.json");
  let selection: Selection;
  try {
    const graph = loadGraph(graphPath);
    const baseGraph = o.baseGraphPath ? loadGraph(o.baseGraphPath) : undefined;

    let headCommitMs: number | undefined;
    if (head !== undefined) headCommitMs = Number(git("log", "-1", "--format=%ct", head).trim()) * 1000;

    let expectedContentRoot = o.expectedContentRoot;
    if (o.daemonVerify) {
      const daemon = daemonContentRoot(repo);
      if (daemon.root === undefined) {
        return {
          kind: "all",
          reasons: [
            {
              kind: "graph-unavailable",
              detail: `daemon verification requested but ${daemon.error ?? "no root returned"}`,
            },
          ],
        };
      }
      expectedContentRoot = daemon.root;
    }

    // cgraph writes paths.json beside graph.json. Absent (an older cgraph, or a
    // hand-built graph) simply means no verdicts and today's behaviour.
    const pathVerdicts = loadPathVerdicts(graphPath);
    const inert = inertManifests(diffText, git, o.range, (p) => nodesInFile(graph, p).length > 0);
    const references = readersOf(diffText, graph, { repo, git, head, regexes, pathVerdicts, inert });

    selection = select(diffText, {
      graph,
      ...(pathVerdicts !== undefined && { pathVerdicts }),
      ...(references !== undefined && { references }),
      ...(inert.size > 0 && { inert }),
      ...(baseGraph !== undefined && { baseGraph }),
      ...(regexes.length > 0 && { ignore: (p: string) => regexes.some((r) => r.test(p)) }),
      ...(o.maxFiles !== undefined && { maxFiles: o.maxFiles }),
      ...(o.maxSelectedFraction !== undefined && { maxSelectedFraction: o.maxSelectedFraction }),
      ...(o.maxTraversalNodes !== undefined && { maxTraversalNodes: o.maxTraversalNodes }),
      ...(o.minDensity !== undefined && { minDensity: o.minDensity }),
      ...(o.minTestReachability !== undefined && { minTestReachability: o.minTestReachability }),
      ...(expectedContentRoot !== undefined && { expectedContentRoot }),
      ...(fileMtimeMs(graphPath) !== undefined && { graphMtimeMs: fileMtimeMs(graphPath) as number }),
      ...(headCommitMs !== undefined && { headCommitMs }),
    });
  } catch (e) {
    return {
      kind: "all",
      reasons: [
        { kind: "graph-unavailable", detail: `cannot load graph at ${graphPath}: ${(e as Error).message}` },
      ],
    };
  }
  return markUnnamed(selection, git, head);
}

/**
 * Readers of the changed files the graph has no node for, as advice for the
 * full-suite comment (see `references.ts`). A failed search is not a graph
 * failure and changes no verdict: it costs only the advice, and says so on
 * stderr.
 */
function readersOf(
  diffText: string,
  graph: CodeGraph,
  o: { repo: string; git: (...args: string[]) => string; head: string | undefined; regexes: RegExp[]; pathVerdicts: PathVerdicts | undefined; inert: Map<string, ScriptAddition> },
): Map<string, Resolution> | undefined {
  const irrelevant = (p: string): boolean =>
    o.regexes.some((r) => r.test(p)) || (o.pathVerdicts !== undefined && isDeliberatelyIgnored(o.pathVerdicts, p));
  const hasNodes = (p: string): boolean => nodesInFile(graph, p).length > 0;
  const unmapped = parseUnifiedDiff(diffText)
    .filter((f) => f.status !== "deleted" && !hasNodes(f.path) && !irrelevant(f.path) && !o.inert.has(f.path))
    .map((f) => f.path);
  if (unmapped.length === 0) return undefined;
  const read = (p: string): string =>
    o.head !== undefined ? o.git("show", `${o.head}:${p}`) : readFileSync(resolve(o.repo, p), "utf8");
  try {
    return resolveReferences(o.git, o.head, unmapped, { hasNodes, read });
  } catch (e) {
    process.stderr.write(`blastline: changed non-code files fail open; searching for their readers failed: ${(e as Error).message}\n`);
    return undefined;
  }
}

/**
 * `package.json` files whose change only adds scripts nothing runs, with why
 * (see `manifest.ts`). Only a two-dot range has a base to compare against; a
 * supplied diff, a three-dot range, an added, deleted or renamed manifest, and
 * any failed read leave the file to fail open as before.
 */
function inertManifests(
  diffText: string,
  git: (...args: string[]) => string,
  range: string | undefined,
  isCode: (path: string) => boolean,
): Map<string, ScriptAddition> {
  const inert = new Map<string, ScriptAddition>();
  const ends = range?.split("..");
  if (ends === undefined || ends.length !== 2 || ends[0] === "" || ends[1] === "" || range?.includes("...")) return inert;
  const [base, head] = ends as [string, string];
  const manifests = parseUnifiedDiff(diffText).filter((f) => f.status === "modified" && /(^|\/)package\.json$/.test(f.path));
  for (const file of manifests) {
    try {
      const why = inertScriptAddition(file.path, git("show", `${base}:${file.path}`), git("show", `${head}:${file.path}`), (names) => {
        const hits = new Map<string, { file: string; line: number; text: string }[]>();
        let out = "";
        try {
          out = git("grep", "-I", "-F", "-n", "-z", "--no-color", ...names.flatMap((n) => ["-e", n]), head, "--", ".", ":!*.md", ":!*.mdx");
        } catch (e) {
          if ((e as { status?: number }).status !== 1) throw e; // 1: no line matched
        }
        // Each hit is `<rev>:<path>\0<line>\0<text>`.
        for (const raw of out.split("\n")) {
          const a = raw.indexOf("\0");
          const b = raw.indexOf("\0", a + 1);
          if (a < 0 || b < 0) continue;
          const hit = { file: raw.slice(head.length + 1, a), line: Number(raw.slice(a + 1, b)), text: raw.slice(b + 1) };
          for (const n of names) if (hit.text.includes(n)) hits.set(n, [...(hits.get(n) ?? []), hit]);
        }
        return hits;
      }, isCode);
      if (why !== null) inert.set(file.path, why);
    } catch (e) {
      process.stderr.write(`blastline: ${file.path} fails open; comparing it failed: ${(e as Error).message}\n`);
    }
  }
  return inert;
}

/**
 * Flag the unmapped files nothing names, so the comment can offer them for
 * `ignore`. Outside the graph's try: a failed search is not a graph failure.
 * It is also not a selection failure -- the verdict is already "run
 * everything" -- so it costs only the suggestion, and says so on stderr.
 */
function markUnnamed(selection: Selection, git: (...args: string[]) => string, head: string | undefined): Selection {
  if (selection.kind !== "all") return selection;
  const paths = selection.reasons.flatMap((r) => (r.kind === "unmapped-file" ? [r.path] : []));
  if (paths.length === 0) return selection;
  let unnamed: Set<string>;
  try {
    unnamed = unnamedFiles(git, head, paths);
  } catch (e) {
    process.stderr.write(`blastline: no ignore suggestions; searching for references failed: ${(e as Error).message}\n`);
    return selection;
  }
  return {
    kind: "all",
    reasons: selection.reasons.map((r) => (r.kind === "unmapped-file" && unnamed.has(r.path) ? { ...r, unnamed: true } : r)),
  };
}
