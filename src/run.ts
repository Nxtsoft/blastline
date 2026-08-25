import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGraph } from "./graph.js";
import { fileMtimeMs, select } from "./select.js";
import type { Selection } from "./types.js";

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

  const graphPath = o.graphPath ?? resolve(repo, "cgraph-out/graph.json");
  try {
    const graph = loadGraph(graphPath);
    const baseGraph = o.baseGraphPath ? loadGraph(o.baseGraphPath) : undefined;

    let headCommitMs: number | undefined;
    if (o.diffText === undefined && o.diffFile === undefined && o.range !== undefined) {
      const head = o.range.split("..").pop() as string;
      headCommitMs = Number(git("log", "-1", "--format=%ct", head).trim()) * 1000;
    }

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

    return select(diffText, {
      graph,
      ...(baseGraph !== undefined && { baseGraph }),
      ...(regexes.length > 0 && { ignore: (p: string) => regexes.some((r) => r.test(p)) }),
      ...(o.maxFiles !== undefined && { maxFiles: o.maxFiles }),
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
}
