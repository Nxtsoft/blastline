/**
 * Phase-3 benchmark harness: historical-commit replay (proposal task 3).
 *
 * For each of the last N first-parent commits touching --src-root:
 *   1. materialize the commit in a worktree, build its CGraph graph
 *   2. run selection on the commit's diff (with the configured ignore rules)
 *   3. record: outcome, fail-open reasons, reduction ratio, determinism, and
 *      the safety proxy — every test file the AUTHOR co-changed in the same
 *      commit must appear in the selection computed from the NON-test changes
 *      (a co-changed test the graph misses is evidence of a blind edge).
 *
 * Usage:
 *   CGRAPH_BIN=/path/to/cgraph bun scripts/bench.ts \
 *     --repo <path> --src-root src --n 20 [--ignore <regex>]...
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTestPath } from "../src/detect.js";
import { parseUnifiedDiff } from "../src/diff.js";
import { loadGraph } from "../src/graph.js";
import { select } from "../src/select.js";
import { testFiles } from "../src/detect.js";

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (dflt !== undefined) return dflt;
  console.error(`missing --${name}`);
  process.exit(2);
}
function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1] as string);
  });
  return out;
}

const repo = arg("repo");
const srcRoot = arg("src-root", "src");
// Extraction root may differ from the commit filter: itsdangerous keeps tests/
// outside src/, so the graph must cover the whole repo while commits are
// filtered to source changes.
const graphRoot = arg("graph-root", srcRoot);
const n = Number(arg("n", "20"));
const cgraphBin = process.env["CGRAPH_BIN"] ?? "cgraph";
const ignoreRes = argAll("ignore").map((r) => new RegExp(r));
const ignore = (p: string) => ignoreRes.some((r) => r.test(p));

const git = (...a: string[]) =>
  execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const commits = git("log", "--first-parent", "--format=%H", `-n`, `${n * 3}`, "--", srcRoot)
  .trim()
  .split("\n")
  .filter(Boolean)
  .slice(0, n);

const work = mkdtempSync(join(tmpdir(), "blastline-bench-"));
const wt = join(work, "wt");
const graphOut = join(work, "graph");

interface Row {
  commit: string;
  files: number;
  kind: string;
  reasons: string[];
  selected: number;
  totalTests: number;
  coChanged: number;
  coChangedHit: number;
  missed: string[];
  deterministic: boolean;
  graphMs: number;
  selectMs: number;
}
const rows: Row[] = [];

for (const commit of commits) {
  try {
    git("worktree", "remove", "--force", wt);
  } catch {
    /* first iteration */
  }
  git("worktree", "add", "--force", "--detach", wt, commit);

  const t0 = Date.now();
  execFileSync(cgraphBin, ["--root", join(wt, graphRoot), "--out", graphOut], { stdio: "ignore" });
  const graphMs = Date.now() - t0;
  const graph = loadGraph(join(graphOut, "graph.json"));
  const allTests = testFiles(graph).size;

  let baseGraph;
  if (process.argv.includes("--with-base-graph")) {
    const baseWt = join(work, "wt-base");
    try {
      git("worktree", "remove", baseWt);
    } catch {
      /* first iteration */
    }
    git("worktree", "add", "--force", "--detach", baseWt, `${commit}~1`);
    const baseOut = join(work, "graph-base");
    execFileSync(cgraphBin, ["--root", join(baseWt, graphRoot), "--out", baseOut], { stdio: "ignore" });
    baseGraph = loadGraph(join(baseOut, "graph.json"));
  }

  const diffText = execFileSync(
    "git",
    ["-C", wt, "diff", "--unified=0", `${commit}~1..${commit}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const changed = parseUnifiedDiff(diffText);

  const t1 = Date.now();
  const sel = select(diffText, { graph, ignore, ...(baseGraph !== undefined && { baseGraph }) });
  const selectMs = Date.now() - t1;
  const sel2 = select(diffText, { graph, ignore, ...(baseGraph !== undefined && { baseGraph }) });
  const deterministic = JSON.stringify(sel) === JSON.stringify(sel2);

  // Safety proxy: selection computed from non-test changes must contain the
  // author's co-changed tests. Rebuild a diff without the test-file hunks.
  // A test deleted by the commit cannot appear in a head-graph selection and
  // cannot be run — only surviving co-changed tests are scoreable.
  const coChangedTests = changed
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path)
    .filter((p) => (graphRoot === "." || p.startsWith(`${graphRoot}/`)) && isTestPath(p));
  let coHit = 0;
  const missed: string[] = [];
  const nonTestDiff = diffText
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      const m = /^diff --git a\/(.+) b\//.exec(chunk);
      return !m || !isTestPath(m[1] as string);
    })
    .join("");
  // A test-only commit has no code change to select from — scoring its
  // co-changed tests against an empty selection penalizes nothing real.
  const hasCodeChange = /^diff --git /m.test(nonTestDiff);
  const scoredCoChanged = hasCodeChange ? coChangedTests.length : 0;
  if (scoredCoChanged > 0) {
    const proxySel = select(nonTestDiff, { graph, ignore, ...(baseGraph !== undefined && { baseGraph }) });
    for (const t of coChangedTests) {
      const hit = proxySel.kind === "all" || proxySel.tests.some((abs) => abs.endsWith(`/${t}`));
      if (hit) coHit++;
      else missed.push(t);
    }
  }

  rows.push({
    commit: commit.slice(0, 8),
    files: changed.length,
    kind: sel.kind,
    reasons: sel.kind === "all" ? sel.reasons.map((r) => JSON.stringify(r)) : [],
    selected: sel.kind === "subset" ? sel.tests.length : allTests,
    totalTests: allTests,
    coChanged: scoredCoChanged,
    coChangedHit: coHit,
    missed,
    deterministic,
    graphMs,
    selectMs,
  });
  console.error(
    `${commit.slice(0, 8)} files=${changed.length} ${sel.kind}${
      sel.kind === "subset" ? ` tests=${sel.tests.length}/${allTests}` : ` (${rows.at(-1)!.reasons.join(",")})`
    } proxy=${coHit}/${coChangedTests.length} graph=${graphMs}ms`,
  );
}
try {
  git("worktree", "remove", "--force", wt);
} catch {
  /* already gone */
}

const subset = rows.filter((r) => r.kind === "subset");
const proxyTotal = rows.reduce((a, r) => a + r.coChanged, 0);
const proxyHit = rows.reduce((a, r) => a + r.coChangedHit, 0);
const summary = {
  repo,
  commits: rows.length,
  subsetRate: subset.length / rows.length,
  failOpenReasons: rows.flatMap((r) => r.reasons),
  meanReduction:
    subset.length > 0
      ? subset.reduce((a, r) => a + (r.totalTests > 0 ? r.selected / r.totalTests : 0), 0) / subset.length
      : null,
  coChangedTests: proxyTotal,
  coChangedSelected: proxyHit,
  missed: rows.flatMap((r) => r.missed),
  allDeterministic: rows.every((r) => r.deterministic),
  meanGraphMs: Math.round(rows.reduce((a, r) => a + r.graphMs, 0) / rows.length),
  meanSelectMs: Math.round(rows.reduce((a, r) => a + r.selectMs, 0) / rows.length),
};
console.log(JSON.stringify({ summary, rows }, null, 2));
writeFileSync(join(work, "results.json"), JSON.stringify({ summary, rows }, null, 2));
console.error(`\nresults written to ${join(work, "results.json")}`);
rmSync(graphOut, { recursive: true, force: true });
