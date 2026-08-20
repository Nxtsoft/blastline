import type { Selection } from "./types.js";

/**
 * The safety-audit loop's core judgment: given the selection blastline made
 * for a merged range and the FULL suite's actual failures, did any failing
 * test fall outside the selection? Such a test is an ESCAPE — a real failure
 * a subset-only run would have missed — and it is the one outcome the "safe
 * superset" contract forbids.
 */
export interface AuditOutcome {
  /** failing test files the selection did not contain */
  escapes: string[];
  /**
   * - "full-run"  — selection failed open, the full suite ran by definition
   * - "clean"     — subset selected, full suite green: nothing to miss
   * - "caught"    — tests failed and every one was inside the subset
   * - "escape"    — at least one failing test was outside the subset
   */
  verdict: "full-run" | "clean" | "caught" | "escape";
}

/**
 * Failures and selections both name absolute test-file paths from the same
 * checkout, but reporters differ in normalization (leading "./", duplicate
 * slashes), so membership is judged on a path-boundary suffix match in BOTH
 * directions — never on raw string equality alone.
 */
function contains(selected: string[], failed: string): boolean {
  return selected.some(
    (s) => s === failed || s.endsWith(`/${failed}`) || failed.endsWith(`/${s}`),
  );
}

export function computeAudit(selection: Selection, failedTestFiles: string[]): AuditOutcome {
  if (selection.kind === "all") {
    return { escapes: [], verdict: "full-run" };
  }
  if (failedTestFiles.length === 0) {
    return { escapes: [], verdict: "clean" };
  }
  const escapes = failedTestFiles.filter((f) => !contains(selection.tests, f)).sort();
  return { escapes, verdict: escapes.length > 0 ? "escape" : "caught" };
}

/** One ledger line — appended per audited push, JSONL on the ledger branch. */
export interface AuditRecord {
  range: string;
  headSha: string;
  kind: "subset" | "all";
  verdict: AuditOutcome["verdict"];
  subsetSize?: number;
  totalTests: number;
  failed: string[];
  escapes: string[];
  contentRoot?: string;
}

/** Roll a ledger up into the badge's message: the accumulating evidence. */
export function badgeFromLedger(records: AuditRecord[]): {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
} {
  const escapes = records.reduce((n, r) => n + r.escapes.length, 0);
  const audited = records.length;
  return {
    schemaVersion: 1,
    label: "selection escapes",
    message: `${escapes} in ${audited} audited ${audited === 1 ? "merge" : "merges"}`,
    color: escapes > 0 ? "red" : "brightgreen",
  };
}
