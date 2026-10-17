import { TEST_RUNNER, typedByPerson } from "./checkpoint.js";

/**
 * What the agent decided while making a commit, read from the compact
 * transcript of its checkpoint, without a model. Each line is something the
 * transcript itself shows: a person's request or correction, a sentence where
 * the agent states a finding or a choice, tests that failed and then passed
 * (or were left failing), a revert, a review it dispatched, design notes the
 * PR adds that weigh alternatives. Nothing is summarised or rewritten; a line
 * is the first sentence that carries the decision, capped.
 *
 * Privacy: only these lines leave the ref, each at most `LINE` characters.
 * Tool output never does: a test's result is read by its status alone, a
 * review by the description the agent gave it, a revert by its description.
 */
export type DecisionKind = "asked" | "steered" | "found" | "tests" | "reverted" | "review" | "alternatives";

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
  input?: { command?: unknown; description?: unknown; subagent_type?: unknown; file_path?: unknown; content?: unknown };
  result?: { status?: unknown };
}

interface TranscriptRecord {
  type?: string;
  content?: Block[];
}

function cap(text: string, n = LINE): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** A reply that only says go on: it steers nothing a reviewer needs. */
const ASSENT = /^(?:y(?:es|eah|ep)?|ok(?:ay)?|sure|go ahead|continue|proceed|sounds good|do it|lgtm|thanks?|thank you|merged?|meregd|done|great|perfect|nice)\b[\s!.,]*(?:let'?s (?:do|go)(?: (?:it|ahead))?)?[\s!.]*$/i;

/**
 * Sentences that state a finding or a choice. Each cue names the reason or
 * the alternative, which is what a reviewer cannot get from the diff.
 */
const CUE =
  /\b(?:found|root cause|because|instead|rather than|turns out|the (?:real |actual )?(?:cause|problem|bug|issue|gap) (?:is|was)|decided|chose|choosing|went with|switched to|you were right|you're right|broke|regress(?:ed|ion)|trade-?off|the fix is|so that|which means|not a (?:bug|regression)|on purpose|deliberately)\b/i;

/** Status lines about the session's own progress: never a decision, whatever cue they carry. */
const CHATTER = /\b(?:waiting|interim|watcher|restarting|polling|still running|re-?running|in progress|on its way|posted|commented on|found (?:0|no|zero) (?:errors?|warnings?|issues?|problems?)|no errors|(?:is|are|was|were) (?:merged|pushed|deployed|live|green))\b/i;

/** "Found X." alone says where the agent looked, not what it learned; a finding carries a clause after it. */
const BARE_FIND = /^(?:I )?found\b[^:;,]*\.?$/i;

/** The sentences of an agent's text, line by line: markdown bullets and headings are lines of their own. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, "").replace(/\*\*|__/g, "").trim();
    if (line === "" || line.startsWith("|")) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z`"(])/)) if (s.trim() !== "") out.push(s.trim());
  }
  return out;
}

/** The first sentence of an agent's text that states a finding or a choice, or undefined. */
export function findingIn(text: string): string | undefined {
  return sentencesOf(text).find((s) => CUE.test(s) && !CHATTER.test(s) && !(BARE_FIND.test(s) && s.split(/\s+/).length < 10) && s.split(/\s+/).length >= 5);
}

/**
 * A test command from its runner to the end of that command, so a `cd` or an
 * env prefix before it, and a pipe, redirect or next command after it, never
 * split one command into two or leak into the line.
 */
function testKey(command: string): string {
  const segments = command.split(/\s*(?:\|\|?|&&|;)\s*/);
  const runs = segments.find((s) => TEST_RUNNER.test(s)) ?? command;
  return cap(runs.replace(/\s*\d?>&?\d?.*$/, "").replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ""), 100);
}

/** Undoing work: a revert, a hard reset, discarding a file's changes, rewriting the last commit. Unstaging (`restore --staged`) is not one. */
const REVERT = /\bgit\s+(?:revert\b|reset\s+--hard\b|restore\s+(?!--staged\b|-S\b)|checkout\s+(?:\S+\s+)?--\s|commit\b[^|;&]*--amend\b)/;
const REVIEW = /\breview/i;
const ALTERNATIVES = /^#{1,6}\s*(?:alternatives?(?: considered)?|options considered|considered alternatives|rejected (?:options|alternatives))\b/im;

/** The first line of the first text block of a user record that a person typed, or "". */
function personLine(record: TranscriptRecord): string {
  for (const block of record.content ?? []) {
    if (typeof block.text !== "string") continue;
    const first = block.text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("You are in a git worktree of ") && !l.startsWith("[Image:"));
    if (first === undefined) continue;
    return typedByPerson(first) ? first : "";
  }
  return "";
}

/**
 * The decisions in one window of a compact transcript. `files` are the
 * repo-relative paths the change carries: design notes count only when it
 * carries them, so a path on the agent's machine never leaves the ref.
 * `opensTurn` says the window starts at the person's request that began the
 * work; otherwise the window continues a turn, and whatever the person says
 * in it steers work already under way.
 */
export function decisionsIn(window: string, files: string[], opensTurn = true): Decision[] {
  const out: Decision[] = [];
  const tests = new Map<string, { at: number; statuses: string[] }>();
  let asked = !opensTurn;
  window.split("\n").forEach((line, at) => {
    if (line.trim() === "") return;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return;
    }
    if (record.type === "user") {
      const said = personLine(record);
      if (said === "") return;
      if (ASSENT.test(said)) {
        asked = true;
        return;
      }
      out.push({ kind: asked ? "steered" : "asked", text: cap(said), at });
      asked = true;
      return;
    }
    if (record.type !== "assistant") return;
    for (const block of record.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        const found = findingIn(block.text);
        if (found !== undefined) out.push({ kind: "found", text: cap(found), at });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      const described = typeof input.description === "string" ? input.description : "";
      if (block.name === "Bash" && typeof input.command === "string") {
        const command = input.command;
        if (TEST_RUNNER.test(command) && typeof block.result?.status === "string") {
          const key = testKey(command);
          const seen = tests.get(key) ?? { at, statuses: [] };
          seen.statuses.push(block.result.status);
          tests.set(key, seen);
        }
        if (REVERT.test(command)) out.push({ kind: "reverted", text: cap(described !== "" ? described : (REVERT.exec(command)?.[0] ?? "git")), at });
        continue;
      }
      if ((block.name === "Agent" || block.name === "Task") && (REVIEW.test(described) || (typeof input.subagent_type === "string" && REVIEW.test(input.subagent_type)))) {
        if (described !== "") out.push({ kind: "review", text: cap(described), at });
        continue;
      }
      if (block.name === "Write" && typeof input.file_path === "string" && input.file_path.endsWith(".md") && typeof input.content === "string" && ALTERNATIVES.test(input.content)) {
        const path = input.file_path;
        const committed = files.find((f) => path === f || path.endsWith(`/${f}`));
        if (committed !== undefined) out.push({ kind: "alternatives", text: committed, at });
      }
    }
  });
  for (const [command, { at, statuses }] of tests) {
    const failed = statuses.indexOf("error");
    if (failed === -1) continue;
    const last = statuses[statuses.length - 1];
    if (last === "success") out.push({ kind: "tests", text: `failed, then passed: ${command}`, at });
    else out.push({ kind: "tests", text: `last run failed: ${command}`, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Which decisions a brief shows when there are more than `limit`: a person's
 * corrections first, then test outcomes, reverts, findings, reviews, design
 * notes, and the opening requests last (the Intent column already shows one).
 * The chosen ones keep their order in the session.
 */
const PRIORITY: DecisionKind[] = ["steered", "tests", "reverted", "found", "review", "alternatives", "asked"];

export function chooseDecisions<T extends { kind: DecisionKind }>(all: T[], limit: number): T[] {
  if (all.length <= limit) return all;
  const ranked = all.map((d, i) => ({ d, i })).sort((a, b) => PRIORITY.indexOf(a.d.kind) - PRIORITY.indexOf(b.d.kind) || a.i - b.i);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.i));
  return all.filter((_, i) => keep.has(i));
}
