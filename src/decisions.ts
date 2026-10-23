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
import { posix } from "node:path";

export type DecisionKind = "tests" | "verified" | "asked" | "reviewed" | "reverted" | "alternatives";

export interface Decision {
  kind: DecisionKind;
  text: string;
  /** Index of the record in the window it came from, so a brief keeps transcript order. */
  at: number;
  /** The tool call a question or review came from: two rounds read alike, so the brief tells them apart by this, not by their text. */
  call?: string;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: { command?: unknown; file_path?: unknown; content?: unknown; questions?: unknown; subagent_type?: unknown; description?: unknown };
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
 * env assignments and a launcher (`npx`, `bunx`, `pnpm exec`, `uv run`, …),
 * itself possibly after `xargs` (the files come from the pipe: group 1).
 * A word like `vitest` inside an `ls`, an `echo` or a branch name is not a run.
 */
const RUN =
  /^(xargs(?:\s+-\S+)*\s+)?(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpm(?:\s+exec)?|yarn|npm(?:\s+exec)?|bun(?:\s+x)?|uv\s+run|poetry\s+run|python3?\s+-m)\s+)?(vitest|jest|mocha|pytest|go\s+test|cargo\s+test|ctest|\.?\/?gradlew?\s+test|mvn\s+(?:verify|test)|(?:npm|bun|pnpm|yarn)(?:\s+run)?\s+test)\b/;

/** A redirect with its target: `> f`, `>> f`, `2> f`, `&> f`, `2>&1`, `< f`. */
const REDIRECT = /\s*(?:(?:\d|&)?>>?|<)\s*(?:&\d|"[^"]*"|'[^']*'|[^\s;&|<>]+)/g;

/** Where a run's own output goes: the file its stdout is redirected to (`> f`, `>> f`, `&> f`, `1> f`), not stderr's. */
function stdoutTarget(stage: string): string | undefined {
  for (const m of stage.matchAll(/(?:^|\s)(&|1)?>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) {
    if (!m[2]!.startsWith("&")) return m[2]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/**
 * A command with each `$NAME` (`"$NAME"`, `${NAME}`) replaced by the literal
 * value the command assigns it (`NAME=value`, `NAME="value"`, `NAME="$OTHER/x"`
 * with `OTHER` assigned before), so a path held in a variable reads as the
 * path. A name assigned from a substitution or an unknown variable is left as it is.
 */
export function expandAssigned(command: string): string {
  // In command order: a use reads the value assigned before it, so a name assigned again later does not reach back.
  const values = new Map<string, string>();
  return command.replace(
    /((?:^|[\s;&|])(?:export\s+)?)([A-Za-z_]\w*)=("[^"`]*"|'[^']*'|[^\s;&|"'$`]+)|"?\$\{?([A-Za-z_]\w*)\}?"?/g,
    (whole, lead: string | undefined, name: string | undefined, value: string | undefined, used: string | undefined) => {
      if (name !== undefined) {
        // A value may use names assigned before it (`NEW="$REPO/x"`); one that still holds an unknown name is not a literal.
        const literal = value!.startsWith("'") ? value!.slice(1, -1) : value!.replace(/^"|"$/g, "").replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, n: string) => values.get(n) ?? m);
        if (literal.includes("$")) values.delete(name);
        else values.set(name, literal);
        return whole;
      }
      return values.get(used!) ?? whole;
    },
  );
}

/**
 * The test run a Bash command holds: exactly one runner in command position
 * across its steps (`&&`, `||`, `;`, new lines, each pipe stage), with
 * `NAME=value` assignments the command makes substituted for `$NAME`, so a
 * file named through a variable still counts. A run against swapped-in code is
 * a probe, not an outcome: one after a step that writes an old version over a
 * file (`git show <ref>:<path> >`), stashes or reverses a patch, or followed by
 * one that puts files back (`cp`, `mv`, `git apply`/`checkout`/`restore`/`stash`,
 * `patch`, also as a loop's `do cp`).
 * Returns the runner, the run's words (quotes stripped), and whether the
 * call's status is the run's own: a single line, `cd` steps before it
 * allowed, nothing after it, not piped (`vitest | grep FAIL` exits 1 on a
 * pass, `vitest | tail` 0 on a fail). `stdin` says the run takes its files
 * from a pipe (`xargs vitest run`), so its words do not say what it ran;
 * `log` is the file its output went to (`> f`, `| tee f`), read by
 * `withLogOutputs`. Undefined with no run, more than one, or a probe.
 */
function testRun(command: string): { runner: string; words: string[]; own: boolean; cd: string | undefined; stdin: boolean; log: string | undefined } | undefined {
  const expanded = expandAssigned(command);
  const steps = expanded.split(/\s*(?:&&|\|\||;|\n)\s*/).filter((step) => step !== "");
  const runs = steps.flatMap((step, at) => {
    const stages = step.split(/\s*\|\s*/);
    return stages.flatMap((raw, s) => {
      const stage = raw.replace(REDIRECT, "");
      const m = RUN.exec(stage);
      if (m === null) return [];
      const tee = /^tee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|<>]+)/.exec(stages[s + 1] ?? "")?.[1]?.replace(/^["']|["']$/g, "");
      return [{ at, runner: m[2]!.replace(/\s+/g, " ").replace(/^\.?\/?/, ""), words: stage.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")), stdin: m[1] !== undefined, log: stdoutTarget(raw) ?? tee }];
    });
  });
  if (runs.length !== 1) return undefined;
  // A probe: code swapped in before the run (an old version written over a file, a stash, a reversed patch)
  // or put back after it, a loop's `do cp` included.
  if (steps.slice(0, runs[0]!.at).some(swapsIn)) return undefined;
  if (steps.slice(runs[0]!.at + 1).some((step) => /^(?:do\s+)?(?:cp|mv|patch|git\s+(?:apply|checkout|restore|stash))\b/.test(step))) return undefined;
  const plain = command.split(/\s*(?:&&|\|\||;)\s*/);
  const own = !command.includes("\n") && plain.slice(0, -1).every((s) => /^cd\s+\S+$/.test(s)) && !plain[plain.length - 1]!.includes("|");
  // Where the run's paths are read from: the last `cd` before it in the same command, when there is one.
  const cd = steps
    .slice(0, runs[0]!.at)
    .map((step) => /^(?:builtin\s+)?cd\s+("[^"]+"|'[^']+'|\S+)$/.exec(step.replace(/\s*\d?>&?\d?\S*/g, "").trim())?.[1]?.replace(/^["']|["']$/g, ""))
    .filter((t): t is string => t !== undefined)
    .pop();
  return { runner: runs[0]!.runner, words: runs[0]!.words, own, cd, stdin: runs[0]!.stdin, log: runs[0]!.log };
}

/**
 * How many test files a run's summary counts: vitest's `Test Files  1 failed | 14 passed (15)`,
 * jest's `Test Suites: 1 failed, 14 passed, 15 total`. Undefined for a runner that prints no such line.
 */
function fileCounts(output: string): { failed: number; total: number } | undefined {
  const vitest = /^[ \t]*Test Files[ \t]+(?:(\d+) failed)?[^\n]*\((\d+)\)[ \t]*$/m.exec(output);
  if (vitest !== null) return { failed: Number(vitest[1] ?? 0), total: Number(vitest[2]) };
  const jest = /^[ \t]*Test Suites:[ \t]+(?:(\d+) failed,)?[^\n]*?\b(\d+) total\b/m.exec(output);
  return jest === null ? undefined : { failed: Number(jest[1] ?? 0), total: Number(jest[2]) };
}

/**
 * The test files a failing run's output names, each once, only when the output proves the list
 * whole: vitest's and jest's `FAIL <file>` lines (a vitest project tag `|web|` aside) counted
 * against the summary's failed files (`fileCounts`), or pytest's `FAILED <file>::<test>` lines,
 * which are one per test, counted as distinct tests against the closing line's `N failed`.
 * Undefined with no such list, no count to check it against, or a count it falls short of (a
 * `| tail` cut it): a partial list cannot say which files failed. Read to match later runs, never
 * shown unless the change carries the file.
 */
function failingFiles(output: string): string[] | undefined {
  const tests = [...output.matchAll(/^[ \t]*FAILED[ \t]+([^\s:]+)::(\S+)/gm)];
  if (tests.length > 0) {
    const failed = /^=+ [^=\n]*?\b(\d+) failed\b[^=\n]* in [\d.]+m?s\b[^=\n]*=+[ \t]*$/m.exec(output)?.[1];
    const ids = new Set(tests.map((m) => `${m[1]}::${m[2]}`));
    if (failed === undefined || Number(failed) !== ids.size) return undefined;
    return [...new Set(tests.map((m) => m[1]!.replace(/^\.\//, "")))];
  }
  const files = new Set<string>();
  for (const m of output.matchAll(/^[ \t]*FAIL[ \t]+(?:\|[^|\n]+\|[ \t]+)?([^\s:]+)/gm)) {
    const file = m[1]!.replace(/^\.\//, "");
    if (/\.\w+$/.test(file)) files.add(file);
  }
  const counts = fileCounts(output);
  if (files.size === 0 || counts === undefined || counts.failed !== files.size) return undefined;
  return [...files];
}

/** `path` as a whole word in `command`: not inside a longer name (`web-full.log` is not `full.log`). */
function namesPath(command: string, path: string): boolean {
  return new RegExp(`(?<![\\w./-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w./-])`).test(command);
}

/** Whether a command writes to `path`: a redirect onto it or a `tee` into it. */
function writesTo(command: string, path: string): boolean {
  const p = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:>>?|\\btee(?:\\s+-a)?)\\s*["']?${p}(?![\\w./-])`).test(command);
}

/**
 * The compact transcript's lines with each test run whose output went to a file (`withLogOutputs`
 * reads `testRun`'s `log`: `vitest run > full.log 2>&1; echo done`) given the output of the first
 * later Bash call that names that file and shows the runner's summary (`grep "Test Files" full.log`,
 * `tail full.log`), before any call writes the file again. Probed on a web-app PR: the
 * full-suite run before the commit and the re-run of its failures both went to logs read minutes
 * later, so neither had an outcome. The output is read as the run's and still never shown; a line
 * that is not JSON, or whose run printed its own summary, is kept as it is.
 */
export function withLogOutputs(lines: string[]): string[] {
  const records = lines.map((line): TranscriptRecord | undefined => {
    try {
      return JSON.parse(line) as TranscriptRecord;
    } catch {
      return undefined;
    }
  });
  const calls: { k: number; block: Block; command: string }[] = [];
  records.forEach((r, k) => {
    for (const block of r?.type === "assistant" ? (r.content ?? []) : []) {
      if (block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") calls.push({ k, block, command: expandAssigned(block.input.command) });
    }
  });
  const changed = new Set<number>();
  calls.forEach((call, i) => {
    const run = testRun(call.block.input!.command as string);
    const log = run?.log;
    if (run === undefined || log === undefined || summaryStatus(run.runner, typeof call.block.result?.output === "string" ? call.block.result.output : "") !== undefined) return;
    for (const later of calls.slice(i + 1)) {
      if (!namesPath(later.command, log)) continue;
      if (writesTo(later.command, log)) return;
      const read = typeof later.block.result?.output === "string" ? later.block.result.output : "";
      if (summaryStatus(run.runner, read) === undefined) continue;
      call.block.result = { ...call.block.result, output: read };
      changed.add(call.k);
      return;
    }
  });
  return lines.map((line, k) => (changed.has(k) ? JSON.stringify(records[k]) : line));
}

/** Flags that change how a run reports, times or schedules its tests, not which tests it runs. */
const NON_SELECTING_FLAG =
  /^(?:--(?:coverage|silent|no-color|passWithNoTests|reporter=\S+|bail(?:=\d+)?|quiet|verbose|run|watch=false|ci|testTimeout=\d+|hookTimeout=\d+|teardownTimeout=\d+|maxWorkers=\S+|minWorkers=\S+|pool=\S+|no-file-parallelism|isolate|no-isolate|runInBand|detectOpenHandles|forceExit|logHeapUsage)|-[qvs]|-i)$/;

/**
 * What a passing run covers: every test of the runner (no argument but
 * flags that do not select tests, `NON_SELECTING_FLAG`; vitest's own `run` word aside), or the folders and files it
 * names. Any other flag (`-t`, `--project`, `--config`, `-k`, `-run`) or a bare
 * word (vitest's file-name filter) narrows it in a way paths cannot say, so it
 * covers nothing.
 */
function coverageOf(runner: string, words: string[]): { all: boolean; paths: string[] } | undefined {
  const last = runner.split(" ").pop()!;
  const args = words.slice(words.indexOf(last) + 1).filter((w, i) => !(i === 0 && runner === "vitest" && w === "run"));
  const rest = args.filter((w) => !NON_SELECTING_FLAG.test(w));
  if (rest.some((w) => w.startsWith("-") || !/[/.]/.test(w))) return undefined;
  return { all: rest.length === 0, paths: rest.map((t) => t.replace(/^\.\//, "").replace(/\/$/, "")) };
}

/**
 * Whether a step writes old code over the working tree before a run: `git show
 * <ref>:<path>` redirected onto that same path, a bare `git stash` (or `push`/`save`),
 * or `git apply -R`. Saving an old copy elsewhere, `git stash pop`/`list` and a
 * `2>` redirect are not.
 */
function swapsIn(step: string): boolean {
  const s = step.replace(/^do\s+/, "");
  const shown = /^git\s+show\s+("[^"]*"|'[^']*'|\S+)/.exec(s)?.[1]?.replace(/^["']|["']$/g, "");
  const onto = /(?:^|\s)(?<![0-9&])>\s*("[^"]*"|'[^']*'|[^\s;&|]+)/.exec(s)?.[1]?.replace(/^["']|["']$/g, "");
  if (shown !== undefined && onto !== undefined && shown.includes(":") && shown.slice(shown.indexOf(":") + 1) === onto) return true;
  return /^git\s+stash(?:\s+(?:push|save)\b|\s*$|\s+-)/.test(s) || /^git\s+apply\s+(?:\S+\s+)*-R\b/.test(s);
}

/**
 * A runner's own summary lines, by runner. vitest prints `Test Files`,
 * `Tests` and `Errors` lines and jest `Test Suites:` and `Tests:` lines,
 * one `Tests` line per run; pytest one closing `===` line. cargo prints a
 * `test result:` line per crate and go an `ok`/`FAIL` line per package, so a
 * pipe can cut the failing one off: theirs count only toward a failure
 * (`passes: false`). Patterns stay on one line (`[ \t]`, `[^=\n]`), so a long
 * output cannot make them backtrack.
 */
const SUMMARIES: { runners: RegExp; line: RegExp; run?: RegExp; passes: boolean }[] = [
  {
    runners: /^(?:vitest|jest|(?:npm|bun|pnpm|yarn)(?: run)? test)$/,
    line: /^[ \t]*(?:Test Files|Tests:?|Test Suites:|Errors)[ \t]+[^\n]*\b(?:passed|failed|errors?)\b[^\n]*$/gm,
    run: /^[ \t]*Tests:?[ \t]/,
    passes: true,
  },
  { runners: /^pytest$/, line: /^=+ [^=\n]*\b(?:passed|failed|errors?)\b[^=\n]* in [\d.]+m?s\b[^=\n]*=+[ \t]*$/gm, run: /^=/, passes: true },
  { runners: /^cargo test$/, line: /^test result: (?:ok|FAILED)\b[^\n]*$/gm, passes: false },
  { runners: /^go test$/, line: /^(?:ok|FAIL)[ \t]+\S+/gm, passes: false },
];

/**
 * A run's outcome from the runner's summary in its output: "error" when any
 * summary line counts a failure, "success" when they count none and the
 * runner's summary can say so. Undefined with no summary, or with two runs'
 * worth where the runner prints one per run (the call ran it twice, and
 * which outcome is which cannot be told).
 */
function summaryStatus(runner: string, output: string): "success" | "error" | undefined {
  const summary = SUMMARIES.find((s) => s.runners.test(runner));
  if (summary === undefined) return undefined;
  const lines = [...output.matchAll(summary.line)].map((m) => m[0]);
  if (lines.length === 0) return undefined;
  if (summary.run !== undefined && lines.filter((l) => summary.run!.test(l)).length > 1) return undefined;
  if (lines.some((l) => /\b[1-9]\d* (?:failed|errors?)\b|\bFAIL(?:ED)?\b/.test(l))) return "error";
  return summary.passes ? "success" : undefined;
}

/** A test file by its name: `x.test.ts`, `x_test.go`, `test_x.py`, or anything under `__tests__/`. */
const TEST_FILE = /(?:[._-](?:test|spec)\.\w+$|_test\.\w+$|(?:^|\/)test_[^/]+$|(?:^|\/)__tests__\/)/;

/** A tool call the harness never ran: a denied permission, or one the person turned down. */
const NEVER_RAN = /^Permission to use \w+ .* has been denied|doesn't want to proceed with this tool use/;

/** Undoing work: a revert, a hard reset, discarding a file's changes. Unstaging and rewriting a commit's metadata are not. */
const REVERTS: [RegExp, string][] = [
  [/\bgit\s+revert\b/, "git revert"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+restore\s+(?!--staged\b|-S\b)/, "git restore"],
  [/\bgit\s+checkout\s+(?:\S+\s+)?--\s/, "git checkout --"],
];

/** What a reviewer concluded, in fixed words. */
export type Verdict = "approved" | "changes requested" | "no findings" | "findings";

/**
 * A reviewer's verdict, read only where a reviewer states one, never from its
 * prose: a `Verdict` line (or the line after a `Verdict` heading), a line that
 * opens with a fixed word (`APPROVE`, `CHANGES REQUESTED`, `BLOCKED`,
 * `READY TO MERGE`), or a check lane's `result: findings|no findings` line.
 * Blocking words win over approving ones on the same line, so "Verdict: BLOCKED.
 * Do not APPROVE" is not an approval and "not APPROVED yet" in a sentence is nothing.
 */
export function verdictOf(text: string): Verdict | undefined {
  const lines = text.split("\n").map((l) => l.replace(/^(?:\s*<[^>]+>)+/, "").replace(/^[\s>#*_`-]+/, "").trim());
  const say = (line: string): Verdict | undefined => {
    if (/^result:\s*no findings\b/i.test(line)) return "no findings";
    if (/^result:\s*findings\b/i.test(line)) return "findings";
    if (/\b(?:BLOCKED|CHANGES REQUESTED|REQUEST CHANGES)\b|^fail\b/.test(line) || /^fail\b/i.test(line)) return "changes requested";
    if (/\bnot\s+(?:yet\s+)?(?:APPROVE[DS]?|READY TO MERGE)\b/i.test(line)) return undefined;
    if (/\b(?:APPROVE[DS]?|READY TO MERGE)\b/.test(line) || /^pass\b/i.test(line)) return "approved";
    return undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const v = /^verdict\b[*_:\s]*(.*)$/i.exec(lines[i]!);
    if (v === null) continue;
    const rest = v[1]!.replace(/^[*_:\s]+/, "");
    const stated = rest !== "" ? rest : (lines.slice(i + 1).find((l) => l !== "") ?? "");
    const verdict = say(stated);
    if (verdict !== undefined) return verdict;
  }
  for (const line of lines) {
    if (/^result:\s*(?:no )?findings\b/i.test(line) || /^(?:APPROVE[DS]?|CHANGES REQUESTED|REQUEST CHANGES|BLOCKED|READY TO MERGE)\b/.test(line)) return say(line);
  }
  return undefined;
}

/** A subagent that reviews: its type or its description names a review or a critic as a word ("critical" and "preview" do not). */
const REVIEWER = /\b(?:review(?:er|ing|s)?|critic|critique)\b/i;

/**
 * Which option a person picked for each question of an `AskUserQuestion` call,
 * by position only: "the recommended option (1 of 3)", "option 2 of 3", or
 * their own words. No question or label is quoted. The answers come from the
 * call's result, `"<question>"="<answer>"`.
 */
function askedIn(input: Block["input"], output: string): string[] {
  const questions = Array.isArray(input?.questions) ? (input.questions as { question?: unknown; options?: { label?: unknown }[] }[]) : [];
  const answers = new Map<string, string>();
  for (const [, q, a] of output.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) answers.set(q!, a!);
  return questions.flatMap((q, i) => {
    if (typeof q.question !== "string") return [];
    const answer = answers.get(q.question);
    if (answer === undefined) return [];
    const labels = (Array.isArray(q.options) ? q.options : []).map((o) => (typeof o?.label === "string" ? o.label : ""));
    // A position is said only when it is certain: one label matches, never two alike.
    const position = (a: string): number => (labels.filter((l) => l === a).length === 1 ? labels.indexOf(a) : -1);
    let which: string;
    if ((q as { multiSelect?: unknown }).multiSelect === true) {
      const picks = answer.split(", ").map(position);
      which = picks.every((p) => p !== -1) ? `you chose options ${picks.map((p) => p + 1).join(", ")} of ${labels.length}` : "you answered in your own words";
    } else {
      const picked = position(answer);
      which = picked === -1 ? "you answered in your own words" : `you chose ${/\(Recommended\)/.test(answer) ? "the recommended option" : "option"} ${picked + 1} of ${labels.length}`;
    }
    return [questions.length > 1 ? `question ${i + 1} of ${questions.length}: ${which}` : which];
  });
}

/** A design note's heading that weighs options. */
const ALTERNATIVES = /^#{1,6}\s*(?:alternatives?(?: considered)?|options considered|considered alternatives|rejected (?:options|alternatives))\b/im;

/**
 * The decisions in one window of a compact transcript. `files` are the
 * repo-relative paths the change carries: a test file or design note is
 * named only when the change carries it. `committed` reads a carried file as
 * the commit holds it: a verification note's status is read there, so an edit
 * after the note was first written is not missed (without it, from what the
 * transcript wrote).
 */
export function decisionsIn(window: string, files: string[], committed?: (path: string) => string | undefined): Decision[] {
  const out: Decision[] = [];
  const carried = (path: string): string | undefined => files.find((f) => path === f || path.endsWith(`/${f}`));
  // A runner prints paths from where it ran. With the run's directory known, the path is read from there: relative to
  // the repo root for a relative `cd`, or the changed file that the absolute path ends with (the longest one). With it
  // unknown, the path is the changed file itself, or the one changed file it ends. Undefined: not in the change; null:
  // cannot be told (two changed files end alike), so the file is neither named nor said to be outside.
  const inChange = (path: string, cd: string | undefined): string | undefined | null => {
    if (cd !== undefined && !/^[~$]/.test(cd)) {
      const full = posix.normalize(`${cd}/${path}`);
      if (!cd.startsWith("/")) return files.find((f) => f === full);
      return files.filter((f) => full.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0];
    }
    const exact = files.find((f) => f === path);
    if (exact !== undefined) return exact;
    const ends = files.filter((f) => f.endsWith(`/${path}`));
    return ends.length === 0 ? undefined : ends.length === 1 ? ends[0] : null;
  };
  // One entry per run target (runner, what it ran, and where: two different known directories never share one), so two
  // runs of different files, or of the same files in two checkouts, never close each other.
  const tests: TestGroup[] = [];
  // Every passing run, with what it covers (`coverageOf`), where it ran, how many files it counts, and whether it took
  // its files from a pipe: later passes of the same runner that together cover a failure's files from the same
  // directory close it, and any pass of that runner from the failure's record on keeps it from being called the last word.
  const passes: { runner: string; at: number; covered: { all: boolean; paths: string[] } | undefined; cd: string | undefined; total: number | undefined; stdin: boolean }[] = [];
  // The last verification note written per path: a note rewritten after a FAIL says the final word.
  const verified = new Map<string, Decision>();
  // A reviewer started in the background reports later, in a task notification naming its call.
  const reviews: { id: string; at: number; reviewer: string; verdict: string | undefined }[] = [];
  const notes: string[] = [];
  window.split("\n").forEach((line, at) => {
    if (line.trim() === "") return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return;
    }
    if (record.type === "user") {
      for (const c of record.content ?? []) if (typeof c.text === "string" && c.text.includes("<task-notification>")) notes.push(c.text);
      return;
    }
    if (record.type !== "assistant") return;
    for (const block of record.content ?? []) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      const output = typeof block.result?.output === "string" ? block.result.output : "";
      for (const note of notesWritten(block)) {
        const path = carried(note.path);
        if (path === undefined || !path.endsWith(".md")) continue;
        if (note.content !== undefined && ALTERNATIVES.test(note.content)) out.push({ kind: "alternatives", text: path, at });
        // The transcript proves the session wrote the note; its status is the one the commit holds.
        const text = committed !== undefined ? committed(path) : note.content;
        const status = /verif/i.test(path.slice(path.lastIndexOf("/") + 1)) && text !== undefined ? verificationStatus(text) : undefined;
        if (status !== undefined) verified.set(path, { kind: "verified", text: `${path}: ${status}`, at });
      }
      if (block.name === "AskUserQuestion") {
        for (const text of askedIn(input, output)) out.push({ kind: "asked", text, at, ...(block.id !== undefined && { call: block.id }) });
        continue;
      }
      if ((block.name === "Agent" || block.name === "Task") && (REVIEWER.test(String(input.subagent_type ?? "")) || REVIEWER.test(String(input.description ?? "")))) {
        const type = typeof input.subagent_type === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(input.subagent_type) ? input.subagent_type : "subagent";
        reviews.push({ id: block.id ?? "", at, reviewer: type, verdict: verdictOf(output) });
        continue;
      }
      if (block.name === "Bash" && typeof input.command === "string") {
        const command = input.command;
        const run = testRun(command);
        const own = run?.own === true && typeof block.result?.status === "string" && !NEVER_RAN.test(output) ? block.result.status : undefined;
        // A run that exited non-zero on its own failed, whatever a summary line it printed says.
        const status = run === undefined ? undefined : own === "error" ? own : (summaryStatus(run.runner, output) ?? own);
        if (run !== undefined && status !== undefined) {
          // Files are named only when the run targets nothing else: a run over a folder or another file may have failed
          // there. Only test files are named: a carried config file a flag points at (`--config`) is not what ran.
          const targets = run.words.slice(run.words.findIndex((w) => w === run.runner.split(" ").pop()) + 1).filter((w) => !w.startsWith("-") && /[/.]/.test(w));
          const all = targets.map(carried);
          const named = !run.stdin && all.every((f) => f !== undefined && TEST_FILE.test(f)) ? [...new Set(all as string[])] : [];
          // Files fed through a pipe say nothing about what ran.
          const covered = run.stdin ? undefined : coverageOf(run.runner, run.words);
          const counts = fileCounts(output);
          const failing = status === "error" ? failingFiles(output) : undefined;
          if (status === "success") passes.push({ runner: run.runner, at, covered, cd: run.cd, total: counts?.total, stdin: run.stdin });
          // A re-run of an earlier failure's files, fed from a pipe (`xargs vitest run`) so its words do not say which: it
          // ran as many files as that failure still had failing, and each file failing now was failing then. A narrowed
          // run (`-t`, a bare name) can count the same number of files by chance, so it is never one.
          const rerunOf =
            run.stdin && failing !== undefined && counts !== undefined
              ? tests.find((g) => g.runner === run.runner && sameDir(g.cd, run.cd) && g.failing !== undefined && g.failing.length === counts.total && failing.every((f) => g.failing!.includes(f)))
              : undefined;
          if (rerunOf !== undefined) {
            rerunOf.last = at;
            rerunOf.statuses.push(status);
            rerunOf.failing = failing;
            rerunOf.reran = true;
          } else if (status === "error" || covered !== undefined) {
            // A narrowed pass (`-t`, `-k`, `-run`, `--project`, a bare name) closes no failure, even of the same target.
            // A run with no `cd` of its own joins one that has one (the shell keeps its directory between calls); two
            // different known directories never share a target.
            const target = covered === undefined ? `?${at}` : covered.all ? "*" : [...covered.paths].sort().join("\0");
            let seen = tests.find((g) => g.runner === run.runner && g.target === target && sameDir(g.cd, run.cd));
            if (seen === undefined) {
              seen = { at, last: at, statuses: [], runner: run.runner, target, cd: run.cd, firstCd: run.cd, named, whole: covered?.all === true, failing: undefined, first: undefined, reran: false };
              tests.push(seen);
            }
            seen.last = at;
            if (run.cd !== undefined) seen.cd = run.cd;
            seen.statuses.push(status);
            if (status === "error") {
              seen.failing = failing;
              if (seen.first === undefined) {
                seen.first = failing;
                seen.firstCd = run.cd;
              }
            }
          }
        }
        const revert = REVERTS.find(([r]) => r.test(command));
        if (revert !== undefined) out.push({ kind: "reverted", text: revert[1], at });
        continue;
      }
    }
  });
  out.push(...verified.values());
  for (const r of reviews) {
    const reported = r.verdict ?? (r.id === "" ? undefined : notes.filter((n) => n.includes(r.id)).map(verdictOf).find((v) => v !== undefined));
    out.push({ kind: "reviewed", text: `${code(r.reviewer)}: ${reported ?? "verdict not recorded"}`, at: r.at, ...(r.id !== "" && { call: r.id }) });
  }
  for (const g of tests) {
    if (!g.statuses.includes("error")) continue;
    // Later passes close a failure when, from the same directory, one runs every test of the runner, or together they
    // name each file still failing (by the output's own list, else the run's named files) or a folder holding it, or one
    // fed from a pipe counts exactly as many files as were failing. Calls in one record have no known order, so only a
    // later record closes.
    const later = passes.filter((p) => p.runner === g.runner && sameDir(p.cd, g.cd) && p.at > g.last);
    const need = g.failing ?? (g.named.length > 0 ? g.named : undefined);
    const covers = (p: (typeof passes)[number], f: string): boolean => p.covered !== undefined && p.covered.paths.some((t) => f === t || f.startsWith(`${t}/`));
    const rerun = g.failing !== undefined && later.some((p) => p.stdin && p.total === g.failing!.length);
    const closed =
      g.statuses[g.statuses.length - 1] === "success" || later.some((p) => p.covered?.all === true) || (need !== undefined && need.every((f) => later.some((p) => covers(p, f)))) || rerun;
    // The failing files are named when the change carries each as a test file; otherwise counted, and said to be outside
    // the change when none of them is in it.
    const listed = g.first?.map((f) => inChange(f, g.firstCd));
    const shown = g.named.length > 0 ? g.named : listed !== undefined && listed.every((f) => typeof f === "string" && TEST_FILE.test(f)) ? [...new Set(listed as string[])] : [];
    const more = shown.length > NAMED_FILES ? ` and ${shown.length - NAMED_FILES} more` : "";
    const label = shown.length > 0 ? `${code(g.runner)} on ${shown.slice(0, NAMED_FILES).map(code).join(", ")}${more}` : g.whole ? `${code(g.runner)} (whole suite)` : code(g.runner);
    const count = shown.length === 0 && g.first !== undefined ? ` in ${g.first.length} ${g.first.length === 1 ? "file" : "files"}` : "";
    const outside = listed !== undefined && listed.every((f) => f === undefined) ? ", none in this change" : "";
    if (closed) out.push({ kind: "tests", text: `${label} failed${count}${outside}, then passed${g.reran || rerun ? " when re-run" : ""}`, at: g.at });
    // Failures all outside the change are said whatever ran after: the reviewer reads that the commit went in with them.
    else if (outside !== "") out.push({ kind: "tests", text: `${label} failed${count}${outside}${g.reran && g.failing !== undefined ? `; ${g.failing.length} still failed when re-run` : ""}`, at: g.at });
    // A failure the runner passed alongside or after, on other files, is not called the last word: that run may have covered it.
    else if (!passes.some((p) => p.runner === g.runner && p.at >= g.last)) out.push({ kind: "tests", text: `${label} failed${count} on its last run`, at: g.at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Whether two runs can have run in the same directory: the same `cd`, or one with none, which runs wherever
 * the shell already stood (it keeps its directory between calls). Two different `cd`s never match.
 */
function sameDir(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/** One run target's runs in a window: what failed in it, and whether a re-run of its failures followed. */
interface TestGroup {
  at: number;
  last: number;
  statuses: string[];
  runner: string;
  /** What it ran: `*` for every test, the sorted paths, or a one-off key for a run whose words do not say. */
  target: string;
  /** The `cd` its runs gave, when one did. */
  cd: string | undefined;
  /** Where its first failing run's output was read from, for its failing paths. */
  firstCd: string | undefined;
  /** The change's test files the run named, when it named nothing else. */
  named: string[];
  /** It ran every test of the runner. */
  whole: boolean;
  /** The files its latest failing run's output named failing (`failingFiles`); undefined when that run named none. */
  failing: string[] | undefined;
  /** The files its first failing run named failing. */
  first: string[] | undefined;
  /** A re-run of its failing files followed (`decisionsIn`). */
  reran: boolean;
}

/**
 * The notes a tool call writes: a `Write`'s file or a Bash heredoc (`cat >
 * <file> <<'EOF'`, `cat <<'EOF' > <file>`) with the whole text, and an `Edit`
 * or `MultiEdit` with none (it proves the session wrote the note, not what the
 * note says). Variables the command assigns read as their values. Read for
 * headings and a status line, never shown.
 */
function notesWritten(block: Block): { path: string; content: string | undefined }[] {
  const input = block.input ?? {};
  if (block.name === "Write") return typeof input.file_path === "string" && typeof input.content === "string" ? [{ path: input.file_path, content: input.content }] : [];
  if (block.name === "Edit" || block.name === "MultiEdit") return typeof input.file_path === "string" ? [{ path: input.file_path, content: undefined }] : [];
  if (block.name !== "Bash" || typeof input.command !== "string") return [];
  const command = expandAssigned(input.command);
  const notes: { path: string; content: string | undefined }[] = [];
  const unquote = (s: string): string => s.replace(/^["']|["']$/g, "");
  for (const m of command.matchAll(/\bcat\s+>\s*("[^"]+"|'[^']+'|[^\s<>;&|]+)\s*<<-?\s*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n\3[ \t]*(?=\n|$)/g)) notes.push({ path: unquote(m[1]!), content: m[4]! });
  for (const m of command.matchAll(/\bcat\s+<<-?\s*(['"]?)(\w+)\1\s*>\s*("[^"]+"|'[^']+'|[^\s<>;&|]+)[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g)) notes.push({ path: unquote(m[3]!), content: m[4]! });
  return notes;
}

/**
 * The status a verification note states, in fixed words: its front matter's
 * `status:` (or `result:`, `verdict:`) line, else the status lines in its body
 * (`**Status:** PASS`) when they all agree; one section passing and another
 * failing is no overall verdict. PASS, FAIL or PARTIAL; undefined otherwise.
 */
export function verificationStatus(content: string): "PASS" | "FAIL" | "PARTIAL" | undefined {
  const line = /^[ \t>*_-]*(?:status|result|verdict)[*_]*[ \t]*:[ \t]*[*_]*[ \t]*(PASS(?:ED)?|FAIL(?:ED)?|PARTIAL)\b/gim;
  const word = (w: string): "PASS" | "FAIL" | "PARTIAL" => (w.toUpperCase().startsWith("PASS") ? "PASS" : w.toUpperCase().startsWith("FAIL") ? "FAIL" : "PARTIAL");
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const stated = front === undefined ? undefined : [...front.matchAll(line)][0]?.[1];
  if (stated !== undefined) return word(stated);
  const said = new Set([...content.matchAll(line)].map((m) => word(m[1]!)));
  return said.size === 1 ? [...said][0] : undefined;
}

/**
 * Which decisions a brief shows when there are more than `limit`: test
 * outcomes first, then questions to the person, reviews, reverts and design
 * notes. The chosen ones keep their order in the session.
 */
const PRIORITY: DecisionKind[] = ["tests", "verified", "asked", "reviewed", "reverted", "alternatives"];

export function chooseDecisions<T extends { kind: DecisionKind }>(all: T[], limit: number): T[] {
  if (all.length <= limit) return all;
  const ranked = all.map((d, i) => ({ d, i })).sort((a, b) => PRIORITY.indexOf(a.d.kind) - PRIORITY.indexOf(b.d.kind) || a.i - b.i);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.i));
  return all.filter((_, i) => keep.has(i));
}
