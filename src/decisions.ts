/**
 * What the agent decided while making a commit, read from the compact
 * transcript of its checkpoint, without a model: a test the commit's work
 * made pass (or left failing), work it undid, design notes the change adds
 * that weigh alternatives.
 *
 * Privacy: no free text is quoted, neither what a person typed nor what the
 * agent wrote. Every line is built from a fixed label, a test runner's name
 * and the change's own repo paths, so nothing private can leave the ref
 * however the session went: a test is read by its runner, the test files the
 * change carries, and its call's status; a revert by a fixed label; design
 * notes by the change's own path. Tool output never leaves.
 */
export type DecisionKind = "tests" | "reverted" | "alternatives";

export interface Decision {
  kind: DecisionKind;
  text: string;
  /** Index of the record in the window it came from, so a brief keeps transcript order. */
  at: number;
}

/** The longest line a decision carries. */
export const LINE = 160;

interface Block {
  type?: string;
  name?: string;
  input?: { command?: unknown; file_path?: unknown; content?: unknown };
  result?: { status?: unknown };
}

interface TranscriptRecord {
  type?: string;
  content?: Block[];
}

/**
 * One line, at most `n` characters. A cut inside a code span drops the open
 * span, so its backtick cannot pair with one the brief puts after the line.
 */
export function cap(text: string, n = LINE): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  let cut = one.slice(0, n - 1);
  if ((cut.match(/`/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("`")).trimEnd();
  return `${cut}…`;
}

/**
 * A test runner in command position: at the start of the command, after any
 * env assignments and a launcher (`npx`, `bunx`, `pnpm exec`, `uv run`, …).
 * A word like `vitest` inside an `ls`, an `echo` or a branch name is not a run.
 */
const RUN =
  /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpm(?:\s+exec)?|yarn|npm(?:\s+exec)?|bun(?:\s+x)?|uv\s+run|poetry\s+run|python3?\s+-m)\s+)?(vitest|jest|mocha|pytest|go\s+test|cargo\s+test|ctest|\.?\/?gradlew?\s+test|mvn\s+(?:verify|test)|(?:npm|bun|pnpm|yarn)(?:\s+run)?\s+test)\b/;

/**
 * The test run a Bash command is, when its status is the run's own: a single
 * line, `cd` steps before it allowed, nothing after it, and the runner in
 * command position. Returns the runner and the command's words, or
 * undefined. A run inside a script, followed by `&&`/`||`/`;` steps, or piped
 * anywhere is not read: the call's status would be the script's or the last
 * pipe's (`vitest | grep FAIL` exits 1 on a pass, `vitest | tail` 0 on a fail).
 */
function testRun(command: string): { runner: string; words: string[] } | undefined {
  if (command.includes("\n")) return undefined;
  const steps = command.split(/\s*(?:&&|\|\||;)\s*/);
  const last = steps[steps.length - 1]!;
  if (!steps.slice(0, -1).every((s) => /^cd\s+\S+$/.test(s))) return undefined;
  if (last.includes("|")) return undefined;
  const bare = last.replace(/\s*\d?>&?\d?\S*/g, "");
  const m = RUN.exec(bare);
  if (m === null) return undefined;
  return { runner: m[1]!.replace(/\s+/g, " ").replace(/^\.?\/?/, ""), words: bare.split(/\s+/) };
}

/** Undoing work: a revert, a hard reset, discarding a file's changes. Unstaging and rewriting a commit's metadata are not. */
const REVERTS: [RegExp, string][] = [
  [/\bgit\s+revert\b/, "git revert"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+restore\s+(?!--staged\b|-S\b)/, "git restore"],
  [/\bgit\s+checkout\s+(?:\S+\s+)?--\s/, "git checkout --"],
];

/** A design note's heading that weighs options. */
const ALTERNATIVES = /^#{1,6}\s*(?:alternatives?(?: considered)?|options considered|considered alternatives|rejected (?:options|alternatives))\b/im;

/**
 * The decisions in one window of a compact transcript. `files` are the
 * repo-relative paths the change carries: a test file or design note is
 * named only when the change carries it.
 */
export function decisionsIn(window: string, files: string[]): Decision[] {
  const out: Decision[] = [];
  const carried = (path: string): string | undefined => files.find((f) => path === f || path.endsWith(`/${f}`));
  const tests = new Map<string, { at: number; statuses: string[] }>();
  window.split("\n").forEach((line, at) => {
    if (line.trim() === "") return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return;
    }
    if (record.type !== "assistant") return;
    for (const block of record.content ?? []) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      if (block.name === "Bash" && typeof input.command === "string") {
        const command = input.command;
        const run = testRun(command);
        if (run !== undefined && typeof block.result?.status === "string") {
          const named = [...new Set(run.words.map(carried).filter((f): f is string => f !== undefined))];
          const key = named.length > 0 ? `\`${run.runner}\` on ${named.map((f) => `\`${f}\``).join(", ")}` : `\`${run.runner}\``;
          const seen = tests.get(key) ?? { at, statuses: [] };
          seen.statuses.push(block.result.status);
          tests.set(key, seen);
        }
        const revert = REVERTS.find(([r]) => r.test(command));
        if (revert !== undefined) out.push({ kind: "reverted", text: revert[1], at });
        continue;
      }
      if (block.name === "Write" && typeof input.file_path === "string" && input.file_path.endsWith(".md") && typeof input.content === "string" && ALTERNATIVES.test(input.content)) {
        const committed = carried(input.file_path);
        if (committed !== undefined) out.push({ kind: "alternatives", text: committed, at });
      }
    }
  });
  for (const [key, { at, statuses }] of tests) {
    if (!statuses.includes("error")) continue;
    out.push({ kind: "tests", text: cap(statuses[statuses.length - 1] === "success" ? `${key} failed, then passed` : `${key} failed on its last run`), at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Which decisions a brief shows when there are more than `limit`: test
 * outcomes first, then reverts and design notes.
 * The chosen ones keep their order in the session.
 */
const PRIORITY: DecisionKind[] = ["tests", "reverted", "alternatives"];

export function chooseDecisions<T extends { kind: DecisionKind }>(all: T[], limit: number): T[] {
  if (all.length <= limit) return all;
  const ranked = all.map((d, i) => ({ d, i })).sort((a, b) => PRIORITY.indexOf(a.d.kind) - PRIORITY.indexOf(b.d.kind) || a.i - b.i);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.i));
  return all.filter((_, i) => keep.has(i));
}
