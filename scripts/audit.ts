/**
 * The safety-audit loop's runner (one invocation per push to main):
 *
 *   1. replay blastline's selection for the pushed range
 *   2. run the FULL suite with vitest's JSON reporter
 *   3. judge the outcome (src/audit.ts) — any failing test file outside the
 *      selection is an ESCAPE, the one thing "safe superset" forbids
 *   4. write the record to --out (scripts/ledger-merge.ts folds it into the
 *      ledger branch, race-safely)
 *
 * Exits 0 for full-run/clean/caught, 1 for escape (so CI alarms loudly), and
 * 2 for plumbing failures. The full suite failing does NOT fail the audit —
 * recording failures is the audit's job.
 *
 * Usage:
 *   bun scripts/audit.ts --range <base>..<head> --graph graph.json \
 *     [--base-graph graph.json] --out DIR
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeAudit } from "../src/audit.js";
import type { AuditRecord } from "../src/audit.js";
import { runSelection } from "../src/run.js";

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (dflt !== undefined) return dflt;
  console.error(`missing --${name}`);
  process.exit(2);
}

const range = arg("range");
const graphPath = arg("graph");
const baseGraphPath = arg("base-graph", "");
const outDir = arg("out");
const repo = arg("repo", process.cwd());

const selection = runSelection({
  repo,
  range,
  graphPath,
  ...(baseGraphPath !== "" && { baseGraphPath }),
});

// Full suite, JSON reporter. vitest exits non-zero on failures — expected and
// captured, not fatal: the failures are the data.
const vitestOut = join(outDir, "vitest.json");
mkdirSync(outDir, { recursive: true });
try {
  execFileSync(
    "bunx",
    ["vitest", "run", "--reporter=json", `--outputFile=${vitestOut}`],
    { cwd: repo, stdio: ["ignore", "ignore", "inherit"], timeout: 600_000 },
  );
} catch {
  // non-zero exit = failing tests; the JSON file still gets written
}
if (!existsSync(vitestOut)) {
  console.error("vitest produced no JSON output — cannot audit");
  process.exit(2);
}
const results = JSON.parse(readFileSync(vitestOut, "utf8")) as {
  numTotalTestSuites: number;
  testResults: { name: string; status: string }[];
};
const failed = results.testResults
  .filter((t) => t.status === "failed")
  .map((t) => t.name)
  .sort();

const outcome = computeAudit(selection, failed);
const record: AuditRecord = {
  range,
  headSha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  kind: selection.kind,
  verdict: outcome.verdict,
  ...(selection.kind === "subset" && { subsetSize: selection.tests.length }),
  totalTests: results.testResults.length,
  failed,
  escapes: outcome.escapes,
  ...(selection.kind === "subset" &&
    selection.contentRoot !== undefined && { contentRoot: selection.contentRoot }),
};

writeFileSync(join(outDir, "record.json"), JSON.stringify(record, null, 2) + "\n");

console.log(JSON.stringify(record, null, 2));
process.exit(outcome.verdict === "escape" ? 1 : 0);
