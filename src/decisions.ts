import { askOf } from "./checkpoint.js";

/**
 * What the agent decided while making a commit, read from the compact
 * transcript of its checkpoint, without a model. Each line is something the
 * transcript itself shows: a correction a person made, a sentence where the
 * agent states a finding or a choice with its reason, a test the commit's
 * work made pass (or left failing), work it undid, design notes the change
 * adds that weigh alternatives. Nothing is summarised or rewritten.
 *
 * Left out on purpose: the request that opened the work (the Intent column
 * shows it), the titles of reviews the agent dispatched, and anything about
 * operating the change rather than the change itself (git authors, CI,
 * staging, merges, other PRs).
 *
 * Privacy: a line leaves the ref only when `shareable` passes every word in
 * it, so a line holding a path, a URL, an email address, a token or anything
 * but plain words, names and the change's own paths is dropped, never masked. Tool output never leaves: a test is read
 * by its runner, the test files the change carries, and its call's status; a
 * revert by the agent's description of it or a fixed label; design notes by
 * the change's own path.
 */
export type DecisionKind = "steered" | "found" | "tests" | "reverted" | "alternatives";

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

/**
 * Whether a line may leave the ref: every word in it is one a reader can see
 * is harmless, and one word that is not drops the whole line. A deny-list of
 * path, host and token shapes always has a remainder; an allow-list does
 * not. Allowed: a word (with an apostrophe or hyphens), a camelCase or
 * snake_case name whose parts are words, a small number, a few
 * abbreviations and joiners, and a path or file name the change carries.
 * Everything else (a path, URL, host, IP, port, email, entity, token, or a
 * word mixing letters and digits like a password) is dropped, never masked.
 */
const NUMBER = /^(?:\d{1,4}(?:st|nd|rd|th|s|x|ms|px|%)?|\d{1,3}(?:,\d{3})+|\d+\.\d+%?)$/;
const ABBREVIATION = /^(?:e\.g|i\.e|etc|vs|a\.k\.a)$/i;
const JOINER = /^(?:[-–—&+=→]|->)$/;

/**
 * A name built of words: lower case, Capitalised, all capitals up to 12
 * letters, or camelCase whose parts average three letters or more, with
 * digits only as short parts between words. A random run (`AbCdEf`,
 * `xY7kP2`, `hunter2`) fails.
 */
function namedLike(token: string): boolean {
  if (/^(?:\p{Ll}+|\p{Lu}\p{Ll}*|\p{Lu}{1,12})$/u.test(token)) return true;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(token)) return false;
  const parts = token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
  if (parts.join("") !== token) return false;
  const words = parts.filter((p) => !/^\d/.test(p));
  if (words.length < 2) return false;
  if (words.reduce((n, p) => n + p.length, 0) / words.length < 3) return false;
  return parts.every((p) => !/^\d/.test(p) || p.length <= 2);
}

/** A word, a hyphenated compound or a contraction whose every part is a name built of words. */
function wordLike(token: string): boolean {
  return token
    .replace(/['’]\p{L}{1,2}$/u, "")
    .split("-")
    .every((part) => namedLike(part));
}

export function shareable(line: string, files: string[] = []): boolean {
  const carried = (t: string): boolean => files.some((f) => t === f || f.endsWith(`/${t}`) || t.endsWith(`/${f}`));
  return line
    .replace(/[`*]|__/g, "")
    .split(/\s+/)
    .map((t) => t.replace(/^[(["'“‘]+/, "").replace(/[)\]"'”’.,;:!?…]+$/, ""))
    .every((t) => t === "" || wordLike(t) || (/^[A-Za-z]+(?:_[A-Za-z]+)+$/.test(t) && t.split("_").every(namedLike)) || NUMBER.test(t) || ABBREVIATION.test(t) || JOINER.test(t) || carried(t));
}

/** About operating the change, not the change: authors, CI, environments, merges, other PRs. */
const OPERATIONAL =
  /\b(?:git author|author(?:ed)?|staging|production|merge[ds]?|meregd|deploy\w*|promot\w*|rebase\w*|cherry-pick\w*|vercel|CI|e2e|lint\w*|eslint|typecheck\w*|watcher|pipeline|dependabot|push(?:ed|ing)?|PR\s?#?\d+|pull request)\b|(?:^|[\s(])#\d+\b/i;

/** A reply that only says go on: it steers nothing a reviewer needs. */
const ASSENT = /^(?:y(?:es|eah|ep)?|ok(?:ay)?|sure|go ahead|continue|proceed|sounds good|do it|lgtm|thanks?|thank you|done|great|perfect|nice)\b[\s!.,]*(?:let'?s (?:do|go)(?: (?:it|ahead))?)?[\s!.]*$/i;

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
 * named only when the change carries it. `opensTurn` says the window starts
 * at the request that began the work, which the Intent column already shows;
 * every later thing a person says in the window steers work under way.
 */
export function decisionsIn(window: string, files: string[], opensTurn = true): Decision[] {
  const out: Decision[] = [];
  const carried = (path: string): string | undefined => files.find((f) => path === f || path.endsWith(`/${f}`));
  const tests = new Map<string, { at: number; statuses: string[] }>();
  let opened = !opensTurn;
  const push = (kind: DecisionKind, text: string, at: number): void => {
    if (shareable(text, files)) out.push({ kind, text: cap(text), at });
  };
  window.split("\n").forEach((line, at) => {
    if (line.trim() === "") return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return;
    }
    if (record.type === "user") {
      const said = askOf(record);
      if (said === "") return;
      const first = !opened;
      opened = true;
      if (first || ASSENT.test(said) || OPERATIONAL.test(said)) return;
      push("steered", said, at);
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
          if (described !== "" && shareable(described, files) && !OPERATIONAL.test(described)) push("reverted", described, at);
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
 * Which decisions a brief shows when there are more than `limit`: a person's
 * corrections first, then test outcomes, reverts, findings and design notes.
 * The chosen ones keep their order in the session.
 */
const PRIORITY: DecisionKind[] = ["steered", "tests", "reverted", "found", "alternatives"];

export function chooseDecisions<T extends { kind: DecisionKind }>(all: T[], limit: number): T[] {
  if (all.length <= limit) return all;
  const ranked = all.map((d, i) => ({ d, i })).sort((a, b) => PRIORITY.indexOf(a.d.kind) - PRIORITY.indexOf(b.d.kind) || a.i - b.i);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.i));
  return all.filter((_, i) => keep.has(i));
}
