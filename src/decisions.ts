import { WORDS } from "./words.js";

/**
 * What the agent decided while making a commit, read from the compact
 * transcript of its checkpoint, without a model. Each line is something the
 * transcript itself shows: a sentence where the agent states a finding or a
 * choice with its reason, a test the commit's
 * work made pass (or left failing), work it undid, design notes the change
 * adds that weigh alternatives. Nothing is summarised or rewritten.
 *
 * Left out on purpose: anything a person typed (a short password reads like
 * a word, so no filter can clear a person's raw words; the Intent column
 * shows the opening request under its own rules), the titles of reviews the agent dispatched, and anything about
 * operating the change rather than the change itself (git authors, CI,
 * staging, merges, other PRs).
 *
 * Privacy: a line leaves the ref only when `shareable` finds every word in
 * it common English or already public on the PR (a name the diff carries, a
 * reviewer's login), so a path, URL, email, token, random string or a name
 * not on the PR drops the line, never masked. Tool output never leaves: a
 * test is read by its runner, the test files the change carries, and its
 * call's status; a revert by the agent's description of it or a fixed label;
 * design notes by the change's own path.
 */
export type DecisionKind = "found" | "tests" | "reverted" | "alternatives";

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
  text?: string;
  input?: { command?: unknown; description?: unknown; file_path?: unknown; content?: unknown };
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

/** What a decision line is checked against, beyond common English: what is already public on the PR. */
export interface Quoting {
  /** Whether the diff carries a word whole: a changed symbol, a changed path or file name, or a whole token in a changed line. */
  carries?: (word: string) => boolean;
  /** Logins already on the PR: its author and reviewers (bots included, `coderabbitai[bot]`). */
  people?: string[];
}

/**
 * Whether a line may leave the ref: every word in it is common English or
 * already public on the PR, and one word that is not drops the whole line,
 * never masked. Common English is SCOWL's size-50 list (`src/words.ts`); a
 * random string is not in it, and neither is a person's or a company's name.
 * A capitalised word inside a sentence is a name whatever it spells (Acme,
 * Smith), so it passes only when the diff carries it, a login on the PR
 * starts with it, or it names public software (React, Postgres). Also allowed: an acronym, a small number or
 * version, a few abbreviations and joiners, a path or file name the change
 * carries, a camelCase or snake_case name built of words or carried by the
 * diff, and in code font a call or accessor chain of such names (never all
 * digits, never a dotted host). A line that says what a password, PIN or OTP
 * is, or sets a key, token or secret, goes too.
 */
/** Software words SCOWL lacks, each with -s, -es, -ed, -d and -ing forms; a missing one only drops a line. */
const DEVELOPER = new Set(
  (
    "api args arg ascii async auth autofix backend bool boolean bot cli codebase config cors cron crud csrf cwd debounce dedupe dep deps deserialize dev dropdown enum env " +
    "eval falsy flaky frontend getter hotfix html http iframe impl init iterator json lib linter localhost login logout middleware monorepo mutex namespace " +
    "nullable oauth param parser prefetch prod readme refetch regex repo rerender runtime schema setter signup src stderr stdin stdout subagent " +
    "smtp teardown todo tooltip truthy typecheck typed upsert uri url util utils uuid webhook workflow yaml " +
    "max min jest vitest pytest mocha npm pnpm bun node lockfile linting minified bundler transpile codegen"
  ).split(" "),
);
/** Public software, by name: libraries, runtimes, languages and tools, never a person or a client. */
const SOFTWARE = new Set(
  (
    "react next.js nextjs vue svelte angular node node.js deno bun typescript javascript python rust golang java kotlin swift ruby rails django flask " +
    "fastapi express nestjs postgres postgresql mysql sqlite redis mongodb kafka graphql prisma drizzle zod yup tailwind vite webpack esbuild rollup " +
    "eslint prettier vitest jest playwright cypress storybook docker kubernetes terraform github gitlab linux macos windows chrome safari firefox"
  ).split(" "),
);
const DICTIONARY = new Set(WORDS.split("\n"));
const NUMBER = /^(?:\d{1,4}(?:st|nd|rd|th|s|x|ms|px|%)?|\d{1,3}(?:,\d{3})+|\d+\.\d+%?|v\d{1,2}|\d{1,2}(?:\.\d{1,3}){1,2})$/;
const ABBREVIATION = /^(?:e\.g|i\.e|etc|vs|a\.k\.a|e2e|i18n|l10n|a11y)$/i;
const JOINER = /^(?:[-–—&+=→]|->)$/;
/** Two or three capitals pass as an acronym (`CI`, `SSR`); four or five only as a known word (`JSON`, `SMTP`), so a code group (`ABCDE-FGHIJ`) does not. */
const ACRONYM = /^[A-Z]{2,3}s?$/;
const SAYS_SECRET = /\b(?:pass(?:word|phrase|code)?|pwd|pin|otp)s?\s*(?:is|was|are|were|=|:)\s*\S|\b(?:secret|token|api[_ -]?key|key|code|credential)s?\s*[=:]\s*\S/i;

/** A common English word: in the list or the developer words, as a contraction or possessive of one, or two list words of four letters or more joined (`callback`, `checkbox`). */
function english(word: string): boolean {
  const w = word.toLowerCase().replace(/['’](?:s|d|ll|re|ve|m)$/, "");
  if (DICTIONARY.has(w) || /^(?:can|won|shan)['’]t$/.test(w)) return true;
  if ([w, w.replace(/(?:es|s|ed|d|ing)$/, ""), w.replace(/(?:ed|ing)$/, "e"), w.replace(/(.)\1(?:ed|ing)$/, "$1")].some((base) => DEVELOPER.has(base))) return true;
  const not = /^(\w+)n['’]t$/.exec(w);
  if (not !== null) return DICTIONARY.has(not[1]!);
  for (let k = 4; k <= w.length - 4; k++) if (DICTIONARY.has(w.slice(0, k)) && DICTIONARY.has(w.slice(k))) return true;
  return false;
}

/** The words of an identifier: camelCase and snake_case parts, digits as their own parts. */
function partsOf(name: string): string[] | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return undefined;
  const parts = name.split("_").filter((p) => p !== "").flatMap((p) => p.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []);
  return parts.join("") === name.replace(/_/g, "") ? parts : undefined;
}

export function shareable(line: string, files: string[] = [], quoting: Quoting = {}): boolean {
  if (SAYS_SECRET.test(line)) return false;
  // The path itself or its file name: a longer path ending in it (`/home/t/wt/src/a.ts`) names a machine.
  const carried = (t: string): boolean => files.some((f) => t === f || f.endsWith(`/${t}`));
  const known = (t: string): boolean => quoting.carries !== undefined && (quoting.carries(t) || quoting.carries(t.toLowerCase()));
  const person = (t: string): boolean => {
    const w = t.toLowerCase();
    return w.length >= 4 && (quoting.people ?? []).some((login) => login.toLowerCase().replace(/\[bot\]$/, "").replace(/[^a-z0-9]/g, "").startsWith(w));
  };
  // An identifier built of words: each part common English, an acronym, or one or two digits.
  const builtOfWords = (name: string): boolean => {
    const parts = partsOf(name);
    // Digits only inside a real camelCase or snake_case name (`useStep4Query`), never after one word (`hunter2`).
    if (parts === undefined || (parts.some((p) => /^\d/.test(p)) && !/[a-z][A-Z]|_/.test(name))) return false;
    // At most one acronym part (`getHTTPResponse`); random mixed case splits into several (`nagWJNVetSIS`).
    if (parts.filter((p) => /^[A-Z]{2,}$/.test(p) && !english(p)).length > 1) return false;
    return parts.length > 1 && parts.every((p) => (/^\d/.test(p) ? p.length <= 2 : p.length >= 2 && (english(p) || ACRONYM.test(p))));
  };
  const other = (t: string): boolean => t === "" || NUMBER.test(t) || ABBREVIATION.test(t) || JOINER.test(t) || carried(t) || known(t) || SOFTWARE.has(t.toLowerCase());
  // A word in prose; `opens` when it starts a sentence, where a capital is not a name.
  const prose = (t: string, opens: boolean): boolean => {
    if (other(t)) return true;
    if (/^[A-Za-z]+(?:_[A-Za-z0-9]+)+$/.test(t)) return builtOfWords(t);
    return t.split("-").every((p, i) => {
      if (p === "" || /^\d{1,4}$/.test(p) || other(p)) return true;
      if (/^[a-z]+(?:['’][a-z]{1,2}|n['’]t)?$/.test(p)) return english(p);
      if (p === "I" || ACRONYM.test(p) || (/^[A-Z]{4,5}s?$/.test(p) && english(p.replace(/s$/, "")))) return true;
      if (/^[A-Z][a-z]+(?:['’][a-z]{1,2}|n['’]t)?$/.test(p)) return ((opens && i === 0) && english(p)) || person(p);
      // An identifier: lowerCamel built of words; PascalCase is a name unless the diff carries it.
      if (/^[a-z]/.test(p)) return builtOfWords(p);
      return person(p);
    });
  };
  // In code font: each name in a call or accessor chain (`scenario?.summary`, `useEffect()`, `step >= 9`).
  const code = (span: string): boolean =>
    carried(span) ||
    span.split(/\s+/).every((t) => {
      if (t === "" || carried(t) || JOINER.test(t) || /^[<>=!]+$/.test(t)) return true;
      if (/[^\w.()?!<>=\[\],;{}+*&|-]/.test(t)) return false;
      const names = t.split(/[.()?!<>=\[\],;{}+*&|-]+/).filter((n) => n !== "");
      if (names.length > 1 && names.every((n) => /^\d+$/.test(n))) return false;
      if (t.includes(".") && !/\(|\?\./.test(t) && !names.some((n) => /[A-Z]/.test(n) || known(n)) && !NUMBER.test(t)) return false;
      return names.every((n) => /^\d{1,4}$/.test(n) || /^[A-Za-z]$/.test(n) || known(n) || english(n) || ACRONYM.test(n) || builtOfWords(n));
    });
  const spans: string[] = [];
  const text = line.replace(/`([^`]*)`/g, (_, span: string) => {
    spans.push(span);
    return " , ";
  });
  if (!spans.every(code)) return false;
  let opens = true;
  for (const raw of text.replace(/\*\*|__/g, "").split(/\s+/)) {
    if (raw === "") continue;
    const t = raw.replace(/^[(["'“‘]+/, "").replace(/[)\]"'”’.,;:!?…]+$/, "");
    if (!prose(t, opens)) return false;
    opens = /[.!?:]["'”’)]*$/.test(raw) || /^[-–—*]$/.test(raw);
  }
  return true;
}

/** About operating the change, not the change: authors, CI, environments, merges, other PRs. */
const OPERATIONAL =
  /\b(?:git author|author(?:ed)?|staging|production|merge[ds]?|meregd|deploy\w*|promot\w*|rebase\w*|cherry-pick\w*|vercel|CI|e2e|lint\w*|eslint|typecheck\w*|watcher|pipeline|dependabot|push(?:ed|ing)?|PR\s?#?\d+|pull request)\b|(?:^|[\s(])#\d+\b/i;

/** Sentences that state a finding or a choice: each cue names a reason or an alternative, which the diff cannot show. */
const CUE =
  /\b(?:found|root cause|because|instead|rather than|turns out|the (?:real |actual )?(?:cause|problem|bug|issue|gap) (?:is|was)|decided|chose|choosing|went with|switched to|you were right|you're right|broke|regress(?:ed|ion)|trade-?off|the fix is|not a (?:bug|regression)|on purpose|deliberately)\b/i;

/** Status lines about the session's own progress: never a decision, whatever cue they carry. */
const CHATTER =
  /\b(?:waiting|interim|restarting|polling|still running|re-?running|in progress|on its way|posted|commented on|exits? with|found (?:0|no|zero) (?:errors?|warnings?|issues?|problems?)|no errors|(?:is|are|was|were) (?:live|green))\b/i;

/** "Found X." alone says where the agent looked, not what it learned; a finding carries a clause after it. */
const BARE_FIND = /^(?:I )?found\b[^:;,]*\.?$/i;

/** A sentence that only gives the reason for the one before it. */
const REASON_FOLLOWS = /^(?:because|since|that's why|so that)\b/i;

/** The sentences of an agent's text, line by line, outside code fences and quotes; bullets and headings are lines of their own. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    // A quote block is usually pasted tool output or someone else's words.
    if (fenced || raw.trim().startsWith(">")) continue;
    const marked = raw.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, "");
    const line = marked.replace(/\*\*|__/g, "").trim();
    if (line === "" || line.startsWith("|")) continue;
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z`"(])/);
    // A bold lead-in ("**One more issue found.** In both runs …") labels the sentence after it, which carries the substance.
    if (/^(?:\*\*|__)[^*_]+[.!?](?:\*\*|__)\s+\S/.test(marked) && sentences.length > 1) sentences.splice(0, 2, `${sentences[0]} ${sentences[1]}`);
    for (const s of sentences) {
      const sentence = s.trim();
      if (sentence === "") continue;
      if (REASON_FOLLOWS.test(sentence) && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${sentence}`;
      else out.push(sentence);
    }
  }
  return out;
}

/** The first sentence of an agent's text that states a finding or a choice about the change, or undefined. */
export function findingIn(text: string): string | undefined {
  return sentencesOf(text).find(
    (s) => CUE.test(s) && !CHATTER.test(s) && !OPERATIONAL.test(s) && !(BARE_FIND.test(s) && s.split(/\s+/).length < 10) && s.split(/\s+/).length >= 5,
  );
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
 * named only when the change carries it. What a person typed is not read.
 */
export function decisionsIn(window: string, files: string[], quoting: Quoting = {}): Decision[] {
  const out: Decision[] = [];
  const carried = (path: string): string | undefined => files.find((f) => path === f || path.endsWith(`/${f}`));
  const tests = new Map<string, { at: number; statuses: string[] }>();
  const push = (kind: DecisionKind, text: string, at: number): void => {
    if (shareable(text, files, quoting)) out.push({ kind, text: cap(text), at });
  };
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
      if (block.type === "text" && typeof block.text === "string") {
        const found = findingIn(block.text);
        if (found !== undefined) push("found", found, at);
        continue;
      }
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
        if (revert !== undefined) {
          const described = typeof input.description === "string" ? input.description.trim() : "";
          // The fixed label is ours, not quoted, so it needs no check.
          if (described !== "" && shareable(described, files, quoting) && !OPERATIONAL.test(described)) push("reverted", described, at);
          else out.push({ kind: "reverted", text: revert[1], at });
        }
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
    out.push({ kind: "tests", text: statuses[statuses.length - 1] === "success" ? `${key} failed, then passed` : `${key} failed on its last run`, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Which decisions a brief shows when there are more than `limit`: test
 * outcomes first, then reverts, findings and design notes.
 * The chosen ones keep their order in the session.
 */
const PRIORITY: DecisionKind[] = ["tests", "reverted", "found", "alternatives"];

export function chooseDecisions<T extends { kind: DecisionKind }>(all: T[], limit: number): T[] {
  if (all.length <= limit) return all;
  const ranked = all.map((d, i) => ({ d, i })).sort((a, b) => PRIORITY.indexOf(a.d.kind) - PRIORITY.indexOf(b.d.kind) || a.i - b.i);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.i));
  return all.filter((_, i) => keep.has(i));
}
