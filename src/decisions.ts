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
 * change carries, and its outcome (the runner's own summary line in the
 * call's output, else the call's status); a revert by a fixed label; design
 * notes by the change's own path. Tool output is read, and never leaves.
 */
export type DecisionKind = "tests" | "reverted" | "alternatives";

export interface Decision {
  kind: DecisionKind;
  text: string;
  /** Index of the record in the window it came from, so a brief keeps transcript order. */
  at: number;
}

interface Block {
  type?: string;
  name?: string;
  input?: { command?: unknown; file_path?: unknown; content?: unknown };
  result?: { status?: unknown; output?: unknown };
}

interface TranscriptRecord {
  type?: string;
  content?: Block[];
}

/**
 * Text in code font. A path holding a backtick gets a double-backtick span
 * with padding, so nothing after the backtick (an `@name`) leaves code font,
 * where GitHub would turn it into a live mention.
 */
export function code(s: string): string {
  return s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``;
}

/** The most test files a test line names; the rest are counted, so the outcome always fits. */
const NAMED_FILES = 2;

/**
 * A test runner in command position: at the start of the command, after any
 * env assignments and a launcher (`npx`, `bunx`, `pnpm exec`, `uv run`, …).
 * A word like `vitest` inside an `ls`, an `echo` or a branch name is not a run.
 */
const RUN =
  /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpm(?:\s+exec)?|yarn|npm(?:\s+exec)?|bun(?:\s+x)?|uv\s+run|poetry\s+run|python3?\s+-m)\s+)?(vitest|jest|mocha|pytest|go\s+test|cargo\s+test|ctest|\.?\/?gradlew?\s+test|mvn\s+(?:verify|test)|(?:npm|bun|pnpm|yarn)(?:\s+run)?\s+test)\b/;

/**
 * The test run a Bash command holds: exactly one runner in command position
 * across its steps (`&&`, `||`, `;`, new lines, each pipe stage), with
 * `NAME=value` assignments the command makes substituted for `$NAME`, so a
 * file named through a variable still counts. A run followed by a step that
 * puts files back (`cp`, `mv`, `git apply`/`checkout`/`restore`/`stash`,
 * `patch`) is a probe (a test run against swapped-in code), not an outcome.
 * Returns the runner, the run's words (quotes stripped), and whether the
 * call's status is the run's own: a single line, `cd` steps before it
 * allowed, nothing after it, not piped (`vitest | grep FAIL` exits 1 on a
 * pass, `vitest | tail` 0 on a fail). Undefined with no run, more than one,
 * or a probe.
 */
function testRun(command: string): { runner: string; words: string[]; own: boolean } | undefined {
  const values = new Map<string, string>();
  for (const [, name, value] of command.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s;&|"'$`]+)/g)) values.set(name!, value!.replace(/^["']|["']$/g, ""));
  const expanded = command.replace(/"?\$\{?([A-Za-z_]\w*)\}?"?/g, (whole, name: string) => values.get(name) ?? whole);
  const steps = expanded.split(/\s*(?:&&|\|\||;|\n)\s*/).filter((step) => step !== "");
  const runs = steps.flatMap((step, at) =>
    step
      .split(/\s*\|\s*/)
      .map((stage) => stage.replace(/\s*\d?>&?\d?\S*/g, ""))
      .flatMap((stage) => {
        const m = RUN.exec(stage);
        return m === null ? [] : [{ at, runner: m[1]!.replace(/\s+/g, " ").replace(/^\.?\/?/, ""), words: stage.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")) }];
      }),
  );
  if (runs.length !== 1) return undefined;
  if (steps.slice(runs[0]!.at + 1).some((step) => /^(?:cp|mv|patch|git\s+(?:apply|checkout|restore|stash))\b/.test(step))) return undefined;
  const plain = command.split(/\s*(?:&&|\|\||;)\s*/);
  const own = !command.includes("\n") && plain.slice(0, -1).every((s) => /^cd\s+\S+$/.test(s)) && !plain[plain.length - 1]!.includes("|");
  return { runner: runs[0]!.runner, words: runs[0]!.words, own };
}

/**
 * A runner's own summary lines, by runner: vitest and jest print one
 * `Tests` line per run, pytest one closing `===` line, cargo one
 * `test result:` line per crate, go one `ok`/`FAIL` line per package.
 */
const SUMMARIES: { runners: RegExp; line: RegExp; one: boolean }[] = [
  { runners: /^(?:vitest|jest|(?:npm|bun|pnpm|yarn)(?: run)? test)$/, line: /^\s*Tests:?\s+(.*\b(?:passed|failed)\b.*)$/gm, one: true },
  { runners: /^pytest$/, line: /^=+ (.*\b(?:passed|failed|errors?)\b.*) in [\d.]+m?s\b.*=+\s*$/gm, one: true },
  { runners: /^cargo test$/, line: /^test result: (ok|FAILED)\b(.*)$/gm, one: false },
  { runners: /^go test$/, line: /^(ok|FAIL)\s+\S+/gm, one: false },
];

/**
 * A run's outcome from the runner's summary in its output: "error" when the
 * summary counts a failure, "success" when it counts none. Undefined with no
 * summary, or with two where the runner prints one per run (the call ran it
 * twice, and which outcome is which cannot be told).
 */
function summaryStatus(runner: string, output: string): "success" | "error" | undefined {
  const summary = SUMMARIES.find((s) => s.runners.test(runner));
  if (summary === undefined) return undefined;
  const lines = [...output.matchAll(summary.line)].map((m) => m[0]);
  if (lines.length === 0 || (summary.one && lines.length > 1)) return undefined;
  return lines.some((l) => /\b[1-9]\d* (?:failed|errors?)\b|\bFAIL(?:ED)?\b/.test(l)) ? "error" : "success";
}

/** A tool call the harness never ran: a denied permission, or one the person turned down. */
const NEVER_RAN = /^Permission to use \w+ .* has been denied|doesn't want to proceed with this tool use/;

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
  const tests = new Map<string, { at: number; statuses: string[]; runner: string; last: number }>();
  // Where each runner last passed, any files: a later pass of the same runner outranks an earlier failure.
  const passed = new Map<string, number>();
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
        const output = typeof block.result?.output === "string" ? block.result.output : "";
        const own = run?.own === true && typeof block.result?.status === "string" && !NEVER_RAN.test(output) ? block.result.status : undefined;
        const status = run === undefined ? undefined : (summaryStatus(run.runner, output) ?? own);
        if (run !== undefined && status !== undefined) {
          // Files are named only when the run targets nothing else: a run over a folder or another file may have failed there.
          const targets = run.words.slice(run.words.findIndex((w) => w === run.runner.split(" ").pop()) + 1).filter((w) => !w.startsWith("-") && /[/.]/.test(w));
          const named = targets.every((t) => carried(t) !== undefined) ? [...new Set(targets.map(carried).filter((f): f is string => f !== undefined))] : [];
          const more = named.length > NAMED_FILES ? ` and ${named.length - NAMED_FILES} more` : "";
          const key = named.length > 0 ? `${code(run.runner)} on ${named.slice(0, NAMED_FILES).map(code).join(", ")}${more}` : code(run.runner);
          const seen = tests.get(key) ?? { at, statuses: [], runner: run.runner, last: at };
          seen.last = at;
          seen.statuses.push(status);
          if (status === "success") passed.set(run.runner, at);
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
  for (const [key, { at, statuses, runner, last }] of tests) {
    if (!statuses.includes("error")) continue;
    if (statuses[statuses.length - 1] === "success") out.push({ kind: "tests", text: `${key} failed, then passed`, at });
    // A failure the runner passed after, on any files, is not called the last word: the later run may have covered it.
    else if ((passed.get(runner) ?? -1) < last) out.push({ kind: "tests", text: `${key} failed on its last run`, at });
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
