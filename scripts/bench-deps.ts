/**
 * Dependency-filtered replay: turn the co-changed-test safety proxy into a
 * behavioral one (issue CGraph#60 methodology).
 *
 * The proxy in bench.ts counts a "miss" whenever the author co-changed a test
 * that selection did not pick. But "the author touched this test in the same
 * commit" is not "this test depends on the changed code": a repo-wide cleanup
 * sweep (e.g. removing `#[cfg(tokio_unstable)]` attributes) co-changes many
 * tests that depend on nothing, and excluding them is CORRECT, not a miss.
 *
 * This post-processor reads a bench.ts results.json and, for every test the
 * proxy flagged as MISSED, runs an oracle that is independent of the graph:
 *   1. check out the commit; run the missed test target (baseline, must pass)
 *   2. revert the commit's CODE hunks (keep the tests); rebuild; re-run
 *   3. a test that flips pass -> fail/no-build is a TRUE DEPENDENT (a real
 *      miss); a test that still passes was co-changed noise (correct exclusion)
 *
 * It reports the proxy recall alongside the dependency-adjusted picture: how
 * many "misses" are real vs. noise.
 *
 * Usage:
 *   bun scripts/bench-deps.ts --results <results.json> --repo <path> \
 *     [--cargo-features full] [--rustflags "--cfg tokio_unstable"]
 *
 * Test-runner mapping is Cargo integration-test convention: a missed test path
 * `<crate-dir>/tests/<name>.rs` runs as `cargo test -p <crate-dir> --test
 * <name>`. Override the whole invocation with --test-cmd (placeholders {pkg}
 * {test} {wt}) for other build systems.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (dflt !== undefined) return dflt;
  console.error(`missing --${name}`);
  process.exit(2);
}

const resultsPath = arg("results");
const repo = arg("repo");
const features = arg("cargo-features", "full");
const rustflags = arg("rustflags", "--cfg tokio_unstable");
const testCmd = arg("test-cmd", "");

const git = (...a: string[]) =>
  execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// A Cargo integration test `<dir>/tests/<name>.rs` -> package <dir>, target <name>.
function cargoTarget(testPath: string): { pkg: string; test: string } | null {
  const m = /(?:^|\/)([^/]+)\/tests\/([^/]+)\.rs$/.exec(testPath);
  if (!m) return null;
  return { pkg: m[1] as string, test: m[2] as string };
}

// Run one test target in the worktree. Returns true on pass, false on
// failure OR compile error (a compile error is a dependency signal too).
function runTest(wt: string, testPath: string): boolean {
  const t = cargoTarget(testPath);
  const cmd = testCmd
    ? testCmd.split("{wt}").join(wt).split("{pkg}").join(t?.pkg ?? "").split("{test}").join(t?.test ?? "")
    : `cargo test -p ${t?.pkg} --test ${t?.test} --features ${features}`;
  try {
    execSync(cmd, { cwd: wt, stdio: "ignore", env: { ...process.env, RUSTFLAGS: rustflags } });
    return true;
  } catch {
    return false;
  }
}

interface Row {
  commit: string;
  coChanged: number;
  coChangedHit: number;
  missed: string[];
}
const data = JSON.parse(readFileSync(resultsPath, "utf8")) as { rows: Row[] };
const rowsWithMisses = data.rows.filter((r) => r.missed && r.missed.length > 0);

const wt = "/tmp/bench-deps-wt";
interface Classified {
  commit: string;
  test: string;
  verdict: "real-miss" | "noise" | "inconclusive";
}
const classified: Classified[] = [];

for (const row of rowsWithMisses) {
  // The results.json stores 8-char commit prefixes; resolve to a full sha.
  const sha = git("rev-parse", row.commit).trim();
  try {
    git("worktree", "remove", "--force", wt);
  } catch {
    /* first iteration */
  }
  git("worktree", "add", "--force", "--detach", wt, sha);

  // Baseline: the missed tests as authored must pass, or the oracle is void.
  const baseline = new Map<string, boolean>();
  for (const t of row.missed) baseline.set(t, runTest(wt, t));

  // Revert the commit's non-test .rs code files to their parent version.
  const changedFiles = git("show", "--name-only", "--format=", sha)
    .trim()
    .split("\n")
    .filter((f) => /\.rs$/.test(f) && !/(^|\/)tests\//.test(f) && !/_test\.rs$/.test(f));
  for (const f of changedFiles) {
    try {
      const parentContent = git("show", `${sha}~1:${f}`);
      writeFileSync(`${wt}/${f}`, parentContent);
    } catch {
      /* file added in this commit: nothing to revert to */
    }
  }

  // Re-run: a missed test that now breaks depended on the reverted code.
  for (const t of row.missed) {
    const passedBaseline = baseline.get(t) === true;
    const verdict: Classified["verdict"] = !passedBaseline
      ? "inconclusive"
      : runTest(wt, t)
        ? "noise"
        : "real-miss";
    classified.push({ commit: row.commit, test: t, verdict });
    console.error(`  ${row.commit} ${t}: ${verdict}`);
  }
}
try {
  git("worktree", "remove", "--force", wt);
} catch {
  /* already gone */
}

// Proxy totals (as bench.ts reported them) vs. the dependency-adjusted view.
const proxyTotal = data.rows.reduce((a, r) => a + (r.coChanged ?? 0), 0);
const proxySelected = data.rows.reduce((a, r) => a + (r.coChangedHit ?? 0), 0);
const realMisses = classified.filter((c) => c.verdict === "real-miss");
const noiseMisses = classified.filter((c) => c.verdict === "noise");
const inconclusive = classified.filter((c) => c.verdict === "inconclusive");

const summary = {
  repo,
  proxy: { selected: proxySelected, coChanged: proxyTotal, recall: proxySelected / proxyTotal },
  missedClassified: classified.length,
  realMisses: realMisses.map((c) => `${c.commit} ${c.test}`),
  noiseMisses: noiseMisses.map((c) => `${c.commit} ${c.test}`),
  inconclusive: inconclusive.map((c) => `${c.commit} ${c.test}`),
  // Dependency-adjusted recall: noise misses are not real dependents, so drop
  // them from the denominator. Selected co-changes are treated as dependents
  // (a superset-safe assumption); the honest headline is the real-miss count.
  dependencyAdjusted: {
    realMissCount: realMisses.length,
    noiseMissCount: noiseMisses.length,
    recall: proxySelected / (proxySelected + realMisses.length),
  },
};
console.log(JSON.stringify(summary, null, 2));
const out = resultsPath.replace(/\.json$/, "") + ".deps.json";
writeFileSync(out, JSON.stringify({ summary, classified }, null, 2));
console.error(`\ndependency-filtered results written to ${out}`);
