import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Decision } from "./decisions.js";
import { decisionsIn } from "./decisions.js";

/**
 * The reviewable subset of an Entire checkpoint (github.com/entireio/cli): the
 * fields the PR brief may show. This is the privacy allowlist. A checkpoint ref
 * also carries the raw agent transcript (`0/full.jsonl`), which embeds hook
 * output, session paths and pasted user context; nothing here reads it.
 */
export interface Checkpoint {
  /** The id from the commit's `Entire-Checkpoint:` trailer: a 26-character ULID (ref backend) or 12 hex characters (branch backend). */
  id: string;
  /** Full sha of the commit that carries the trailer. */
  commit: string;
  /** `0/metadata.json.agent`, e.g. "Claude Code". */
  agent: string;
  /** `0/metadata.json.model`, e.g. "claude-sonnet-5". */
  model: string;
  /**
   * What a person asked for, at most 200 characters: the first line of the
   * prompt that starts the commit's own turn in the transcript, else the first
   * line a person typed in the first session's `prompt.txt` that has one.
   * `brief --local` has no transcript: the first line a person typed in the
   * session's first message.
   */
  prompt: string;
  /** What the agent said in the part of the compact transcript that belongs to this checkpoint. */
  narration: Narration;
  /** Each session in the checkpoint: its id and how many lines its compact transcript had, so the next checkpoint of that session reads only what came after. */
  sessions: CheckpointSession[];
  /** When every session's part is empty: the earlier commit in the range whose checkpoint already read this transcript, so the same step produced both. */
  sameStepAs?: string;
  /** `metadata.json.files_touched`, repo-relative. */
  filesTouched: string[];
  /** Bash tool calls in the compact transcript whose command names a test runner. */
  testCommands: string[];
  /** `metadata.json.source` when a writer sets one; Entire's own hooks do not, so "entire". */
  source: string;
  /** Why each changed symbol the caller asked about changed, when an edit in the transcript touched it. */
  reasons: SymbolReason[];
  /** What the agent decided in this checkpoint's part of each session (`decisionsIn`), in session order. */
  decisions: Decision[];
}

/**
 * Why one changed symbol changed: the agent's own line of text before the
 * edit that touched it. The edit's path is compared and its contents are
 * searched for the symbol's name; neither is shown.
 */
export interface SymbolReason {
  path: string;
  label: string;
  /** 1-based assistant turn of the edit in the compact transcript. */
  turn: number;
  /** First line of the agent's last text before the edit, at most 200 characters. */
  why: string;
}

/** One session of a checkpoint, as `<i>/metadata.json` and `<i>/transcript.jsonl` describe it. */
export interface CheckpointSession {
  /** `session_id`; "" when the writer set none. */
  id: string;
  /** Non-blank lines in the compact transcript. */
  lines: number;
  /** sha256 of those lines, so the next checkpoint of the session can tell whether its transcript extends this one. */
  hash: string;
}

/** What one earlier checkpoint read of a session: the commit, and the transcript's lines and hash. */
export interface ReadSession {
  sha: string;
  lines: number;
  hash: string;
}

/**
 * What earlier checkpoints in a range already read, per session id. Entire's
 * branch backend snapshots one cumulative transcript per session at each
 * checkpoint, and each snapshot is a prefix of the next (probed on
 * turing-webapp: checkpoint 3886c609f481's 224 lines are the first 224 of
 * d3d8ea5b0e29's 249), so the lines after the previous snapshot are exactly
 * this checkpoint's part. The snapshot's `created_at` is not a boundary:
 * records stamped after it are in it. A writer that stores one transcript
 * per commit (`blastline checkpoint write`) extends nothing, which the hash
 * tells, and its transcript is read whole.
 */
export type ReadSessions = Map<string, ReadSession>;

/**
 * What the agent said in the part of the compact transcript that belongs to
 * one checkpoint: the lines after the previous checkpoint of the same session
 * in the range; the ref backend writes one transcript per commit, so all of it.
 */
export interface Narration {
  /** First line of the agent's first text in the window, at most 200 characters; "" when the window has none. */
  started: string;
  /** First line of the agent's last text in the window when it differs from `started`; "" otherwise. */
  ended: string;
  /** Assistant text blocks in the window. */
  texts: number;
  /** Tool calls in the window. */
  tools: number;
}

/**
 * The two id shapes Entire writes: a 26-character ULID under the ref backend
 * (the default since 0.10.0), 12 hex characters under the branch backend that
 * a repository enabled before 0.10.0 keeps until `entire doctor
 * migrate-checkpoints`.
 */
const TRAILER = /^Entire-Checkpoint:\s*([0-9A-Z]{26}|[0-9a-f]{12})\s*$/m;

/** The shared branch the branch backend writes every checkpoint to, as `<first two>/<rest>/` directories. */
export const CHECKPOINT_BRANCH = "entire/checkpoints/v1";

/** Where a checkpoint's six files may sit: a ref, and the directory inside its tree. */
export interface CheckpointPlace {
  ref: string;
  /** "" for a ref that is the checkpoint, `dd/54cfcde765/` on the shared branch. */
  prefix: string;
}

/**
 * Who made a commit when no checkpoint says: the marks the agents' own
 * tooling leaves on the commit itself. GitHub's Copilot cloud agent adds an
 * `Agent-Logs-Url:` trailer linking the session log (since 2026-03-20); a
 * vendor noreply address as the author or a `Co-authored-by:` names the agent.
 * Weaker than a checkpoint: no prompt, no files, no test commands, so it fills
 * the Intent column and makes no claim the brief could check.
 */
export interface Provenance {
  /** The agent the mark names: `copilot`, `claude-code`. */
  agent: string;
  /** Which mark: `Agent-Logs-Url`, `author`, or `Co-authored-by`. */
  via: "Agent-Logs-Url" | "author" | "Co-authored-by";
  /** The `Agent-Logs-Url:` trailer's link, when the commit carries one. */
  logsUrl?: string;
}

/**
 * Vendor noreply addresses that name the agent, matched after lowercasing and
 * dropping GitHub's `<id>+` prefix: the registry agent-change-control ships
 * (src/provenance/mod.rs, release 0.4.0).
 */
const AGENT_ADDRESSES: Record<string, string> = {
  "noreply@anthropic.com": "claude-code",
  "copilot@users.noreply.github.com": "copilot",
};

/** The agent a vendor address names, or undefined for a human's or an unknown one. */
export function agentForAddress(address: string): string | undefined {
  return AGENT_ADDRESSES[address.trim().toLowerCase().replace(/^\d+\+/, "")];
}

const LOGS_URL = /^Agent-Logs-Url:\s*(\S+)\s*$/m;
const CO_AUTHOR = /^Co-authored-by:.*<([^>]+)>\s*$/gim;

/**
 * A commit's provenance from its own marks: the author address first, then
 * each `Co-authored-by:`, then an `Agent-Logs-Url:` trailer on its own, which
 * only Copilot's cloud agent writes. Undefined for a commit with none.
 */
export function provenanceOf(repo: string, commit: string): Provenance | undefined {
  const [body = "", author = ""] = git(repo, ["log", "-1", "--format=%B%x00%ae", commit]).split("\0");
  const logsUrl = LOGS_URL.exec(body)?.[1];
  const link = logsUrl === undefined ? {} : { logsUrl };
  const byAuthor = agentForAddress(author);
  if (byAuthor !== undefined) return { agent: byAuthor, via: "author", ...link };
  for (const m of body.matchAll(CO_AUTHOR)) {
    const agent = agentForAddress(m[1] ?? "");
    if (agent !== undefined) return { agent, via: "Co-authored-by", ...link };
  }
  if (logsUrl !== undefined) return { agent: "copilot", via: "Agent-Logs-Url", logsUrl };
  return undefined;
}

/** A shell command that runs tests, by the runner it names. */
export const TEST_RUNNER =
  /\b(vitest|jest|mocha|pytest|go test|cargo test|ctest|gradlew? test|mvn (?:verify|test)|(?:npm|bun|pnpm|yarn)(?: run)? test)\b/;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * How text the harness delivers as a prompt begins. Counted over the user
 * records with text in turing-webapp's checkpoint transcripts (272 of them):
 * 5,408 began with a tag (`<task-notification>`, `<system-reminder>`),
 * 1,532 with a Stop hook's feedback, which Claude Code sends after every reply a
 * blocking Stop hook stops, 357 with a skill's instructions, and the rest of
 * these with a usage-limit notice, an interrupt marker or a compaction summary.
 * Each of them, taken as a person's turn, ended the commit's turn at the last
 * reply.
 */
const HARNESS_PROMPTS = [
  "<",
  "Base directory for this skill:",
  "Stop hook feedback:",
  "[Request interrupted by user",
  "This session is being continued from a previous conversation",
  "[Usage limit reached",
  "[Earlier usage-limit notes",
  "Your claude.ai usage limit has reset",
];

/**
 * Whether prompt text was typed by a person rather than delivered by the
 * harness (`HARNESS_PROMPTS`). A slash command's expanded body is not told
 * apart; it carries no mark in the compact transcript.
 */
export function typedByPerson(text: string): boolean {
  const first = text.trim();
  return first !== "" && !HARNESS_PROMPTS.some((prefix) => first.startsWith(prefix));
}

/** The first line of a prompt that is neither blank, the `agents run` preamble, nor an image caption. */
function firstTypedLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("You are in a git worktree of ") && !l.startsWith("[Image:"));
}

/**
 * The line of a prompt that states the intent, capped at 200 characters.
 * `0/prompt.txt` holds every prompt of the turn, separated by `---` lines. A
 * prompt the harness delivered (`typedByPerson`) is skipped whole; so is the
 * preamble a session launched through `agents run` starts with ("You are in
 * a git worktree of <repo> on branch <b>…", one line), and the caption Claude
 * Code puts before an attached image ("[Image: source: …]"). The reviewer sees
 * the first line a person typed.
 */
export function promptLine(prompt: string): string {
  for (const block of prompt.split(/^---\s*$/m)) {
    const first = firstTypedLine(block);
    if (first === undefined || !typedByPerson(first)) continue;
    return first.slice(0, 200);
  }
  return "";
}

/** The checkpoint id a commit's trailer names, or undefined when it carries none. */
export function checkpointTrailer(repo: string, commit: string): string | undefined {
  return TRAILER.exec(git(repo, ["log", "-1", "--format=%B", commit]))?.[1];
}

/** Where Entire's ref backend stores a checkpoint: sharded by the last two characters of its ULID. */
export function checkpointRef(id: string): string {
  return `refs/entire/checkpoints/${id.slice(-2)}/${id}`;
}

/**
 * Where a checkpoint may sit, by the shape of its id: a ULID names one ref; a
 * 12-hex id names a directory on the shared branch, which is read from the
 * local branch first and then from origin's (what the Action fetches).
 */
export function checkpointPlaces(id: string): CheckpointPlace[] {
  if (id.length === 26) return [{ ref: checkpointRef(id), prefix: "" }];
  const prefix = `${id.slice(0, 2)}/${id.slice(2)}/`;
  return [`refs/heads/${CHECKPOINT_BRANCH}`, `refs/remotes/origin/${CHECKPOINT_BRANCH}`].map((ref) => ({ ref, prefix }));
}

/** The first place whose tree holds the checkpoint's `metadata.json`, or undefined when none in this repository does. */
export function checkpointPlace(repo: string, id: string): CheckpointPlace | undefined {
  return checkpointPlaces(id).find((place) => {
    try {
      git(repo, ["cat-file", "-e", `${place.ref}:${place.prefix}metadata.json`]);
      return true;
    } catch {
      return false;
    }
  });
}

/** What the reader can say when a trailer's checkpoint is missing: which push brings it. */
export function checkpointPushHint(id: string): string {
  return id.length === 26 ? "push refs/entire/checkpoints/*" : `push the branch ${CHECKPOINT_BRANCH}`;
}

interface CheckpointMetadata {
  files_touched?: string[];
  source?: string;
  /** One entry per session; only its count is used. Paths are never taken from here. */
  sessions?: unknown[];
}

interface SessionMetadata {
  agent?: string;
  model?: string;
  session_id?: string;
}

/** One record of the compact transcript: a turn with its content blocks. */
interface TranscriptRecord {
  type?: string;
  content?: {
    type?: string;
    name?: string;
    text?: string;
    input?: { command?: unknown; file_path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown; edits?: unknown };
  }[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Whether an edit's text names the symbol as a whole word. */
export function editNames(label: string, text: string): boolean {
  return new RegExp(`(?<![\\w$])${label.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")}(?![\\w$])`).test(text);
}

/** The strings an edit tool call carries, joined, for the name search; never returned. */
function editText(input: NonNullable<TranscriptRecord["content"]>[number]["input"]): string {
  const parts: string[] = [];
  for (const v of [input?.old_string, input?.new_string, input?.content]) if (typeof v === "string") parts.push(v);
  if (Array.isArray(input?.edits)) {
    for (const e of input.edits as { old_string?: unknown; new_string?: unknown }[]) {
      for (const v of [e?.old_string, e?.new_string]) if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join("\n");
}

/**
 * For each symbol asked about, the last edit in the compact transcript that
 * touched it: an `Edit`, `Write` or `MultiEdit` on its file (a `Write`
 * rewrites the whole file, so it touches every symbol there; an edit touches
 * the symbols its text names as whole words). The reason is the first line
 * of the agent's last text block before that edit, in that turn or an earlier
 * one. A line that is not JSON is skipped.
 */
/** A changed symbol to look for: its file, its name, and its line range in the file as committed when known. */
export interface SymbolAt {
  path: string;
  label: string;
  from?: number;
  to?: number;
}

/** The new text an edit wrote, per string, for the line search; never returned. */
function editWrites(input: NonNullable<TranscriptRecord["content"]>[number]["input"]): string[] {
  const out: string[] = [];
  if (typeof input?.new_string === "string") out.push(input.new_string);
  if (Array.isArray(input?.edits)) for (const e of input.edits as { new_string?: unknown }[]) if (typeof e?.new_string === "string") out.push(e.new_string);
  return out;
}

/**
 * Whether `written` sits, verbatim, on a line inside `from..to` of `content`.
 * Every occurrence counts: text an edit wrote that appears in several places
 * is attributed to each symbol holding one, rather than to none.
 */
export function writtenWithin(content: string, written: string, from: number, to: number): boolean {
  if (written === "") return false;
  const height = written.split("\n").length - 1;
  for (let at = content.indexOf(written); at !== -1; at = content.indexOf(written, at + 1)) {
    const start = content.slice(0, at).split("\n").length;
    if (start <= to && from <= start + height) return true;
  }
  return false;
}

/**
 * Whether an edit touched a symbol: a `Write` rewrites the whole file, so it
 * touches every symbol there; otherwise the text the edit wrote sits inside
 * the symbol's line range in the file as committed (`content`), or the
 * edit's text names the symbol as a whole word.
 */
function touches(tool: string, input: NonNullable<TranscriptRecord["content"]>[number]["input"], s: SymbolAt, content: string | undefined): boolean {
  if (tool === "Write") return true;
  if (content !== undefined && s.from !== undefined && s.to !== undefined) {
    for (const written of editWrites(input)) if (writtenWithin(content, written, s.from, s.to)) return true;
  }
  return editNames(s.label, editText(input));
}

export function symbolReasonsIn(transcript: string, symbols: SymbolAt[], contents: (path: string) => string | undefined = () => undefined): SymbolReason[] {
  const reasons = new Map<string, SymbolReason>();
  let turn = 0;
  let lastText = "";
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (record.type !== "assistant") continue;
    turn++;
    for (const block of record.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") lastText = block.text;
      if (block.type !== "tool_use" || block.name === undefined || !EDIT_TOOLS.has(block.name)) continue;
      const path = block.input?.file_path;
      if (typeof path !== "string") continue;
      for (const s of symbols) {
        if (path !== s.path && !path.endsWith(`/${s.path}`)) continue;
        if (!touches(block.name, block.input, s, contents(s.path))) continue;
        reasons.set(`${s.path}\0${s.label}`, { path: s.path, label: s.label, turn, why: promptLine(lastText) });
      }
    }
  }
  return [...reasons.values()];
}

/** The parts of a cumulative transcript one checkpoint may read. */
export interface Windows {
  /** Everything after the previous checkpoint of the same session: where an edit's reason is looked for. */
  sinceWindow: string;
  /** Inside that, from the commit's own turn: where the narration comes from. */
  stepWindow: string;
  /** The commit's own turn whole, whatever an earlier commit read of it: where the test runs come from, so every commit of one turn carries the turn's runs. */
  turnWindow: string;
  /** Non-blank lines in the whole transcript. */
  lines: number;
  /** sha256 of those lines. */
  hash: string;
  /** Whether the transcript extends what the previous checkpoint read, so that part was skipped. */
  extended: boolean;
  /** The first line a person typed in the prompt that starts the commit's own turn, at most 200 characters; "" when it cannot be told. */
  ask: string;
  /** Whether a tool call in the new part works on one of the commit's files. */
  worked: boolean;
  /**
   * Where the commit's decisions are read: from the commit's own turn on,
   * inside what the previous checkpoint of the session left unread, only the
   * turns holding a tool call that works on one of the commit's files by its
   * path; "" when there is none, so a session that only ran alongside, or a
   * turn about something else, contributes nothing.
   */
  decisionWindow: string;
  /** Whether `decisionWindow` starts at the prompt that opened the turn, which the Intent column shows. */
  opensTurn: boolean;
}

/**
 * sha256 over the identity of a transcript's non-blank lines: each record's
 * type, stamp and id, not its text. A snapshot's last record can be a tool
 * call whose `result` arrives in the next snapshot (probed on turing-webapp:
 * 0ec8874549e6's line 191 gains `result` in 5cc9e7709e27), so the text of a
 * prefix changes while its records do not. A line that is not JSON counts as
 * itself.
 */
export function transcriptHash(lines: string[]): string {
  const hash = createHash("sha256");
  for (const line of lines) {
    let key = line;
    try {
      const r = JSON.parse(line) as TranscriptRecord & { id?: unknown; ts?: unknown };
      // A record without an id (blastline's own writer) is its text: two of them a second apart must not look alike.
      key = typeof r.id === "string" ? `${r.type ?? ""}\0${typeof r.ts === "string" ? r.ts : ""}\0${r.id}` : line;
    } catch {
      // not JSON: the line itself is its identity
    }
    hash.update(key).update("\n");
  }
  return hash.digest("hex");
}

/** Whether a user record carries text a person typed (`typedByPerson`). */
function humanTurn(record: TranscriptRecord): boolean {
  return record.type === "user" && typedByPerson(record.content?.find((c) => typeof c.text === "string")?.text ?? "");
}

/**
 * What a person's turn asked, capped at 200 characters: the first line of the
 * first text block a person typed. Each block is judged on its own, so a block
 * the harness appended to the turn (a reminder, an attachment) never supplies
 * the line, however it is laid out; the `agents run` preamble and an image
 * caption are skipped, as `promptLine` skips them.
 */
export function askOf(record: { content?: { text?: string }[] }): string {
  for (const block of record.content ?? []) {
    if (typeof block.text !== "string") continue;
    const first = firstTypedLine(block.text);
    if (first !== undefined && typedByPerson(first)) return first.slice(0, 200);
  }
  return "";
}

/**
 * Whether a tool call works on one of `files`: an edit tool by its path, a
 * Bash command by naming the file's basename in its text (an agent that edits
 * through a script or `sed` never calls an edit tool). A basename is not a
 * path, so a common one (`index.ts`) can match an earlier turn's command and
 * start the window early; the previous checkpoint still bounds it.
 */
function worksOn(block: NonNullable<TranscriptRecord["content"]>[number], files: string[]): boolean {
  if (block.type !== "tool_use" || block.name === undefined) return false;
  if (EDIT_TOOLS.has(block.name)) {
    const path = block.input?.file_path;
    return typeof path === "string" && files.some((f) => path === f || path.endsWith(`/${f}`));
  }
  if (block.name === "Bash") {
    const command = block.input?.command;
    return typeof command === "string" && files.some((f) => command.includes(f.slice(f.lastIndexOf("/") + 1)));
  }
  return false;
}

/**
 * Whether a tool call works on one of `files` by its repo-relative path. A
 * Bash command names the whole path, not inside a longer one
 * (`../billing/package.json` is another repo's). An edit tool's absolute
 * path is the repo root plus the file; `root` is that root when a path
 * inside a folder fixed it, else a file at the repo root (`package.json`) is
 * matched by no edit, since any repo has one. Stricter than `worksOn`, whose
 * basename match lets a session that only read another `index.ts` count;
 * decisions quote what a person said, so they need this.
 */
function worksOnPath(block: NonNullable<TranscriptRecord["content"]>[number], files: string[], root: string | undefined): boolean {
  if (block.type !== "tool_use" || block.name === undefined) return false;
  if (block.name === "Bash") {
    const command = block.input?.command;
    return typeof command === "string" && files.some((f) => new RegExp(`(?<![\\w./~-])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`).test(command));
  }
  if (!EDIT_TOOLS.has(block.name)) return false;
  const path = block.input?.file_path;
  if (typeof path !== "string") return false;
  return files.some((f) => path === f || (root !== undefined ? path === `${root}${f}` : f.includes("/") && path.endsWith(`/${f}`)));
}

/** The repo root an edit names: its absolute path less the repo path of a file inside a folder; undefined when no such edit is in `records`. */
function repoRoot(records: (TranscriptRecord | undefined)[], files: string[]): string | undefined {
  for (const r of records) {
    for (const block of r?.type === "assistant" ? (r.content ?? []) : []) {
      const path = block.type === "tool_use" && block.name !== undefined && EDIT_TOOLS.has(block.name) ? block.input?.file_path : undefined;
      if (typeof path !== "string") continue;
      const f = files.find((file) => file.includes("/") && path.endsWith(`/${file}`));
      if (f !== undefined) return path.slice(0, path.length - f.length);
    }
  }
  return undefined;
}

/**
 * The turns from `start` on, each a person's prompt up to the next, that hold
 * a tool call working on one of `files` by path, joined in order. A turn that
 * did no work on the files (an aside before or after the commit's work) is
 * left out whole.
 */
function workingTurns(lines: string[], records: (TranscriptRecord | undefined)[], start: number, files: string[]): string {
  const kept: string[] = [];
  const root = repoRoot(records, files);
  let from = start;
  for (let i = start + 1; i <= records.length; i++) {
    if (i < records.length && !(records[i] !== undefined && humanTurn(records[i]!))) continue;
    if (records.slice(from, i).some((r) => r?.type === "assistant" && (r.content ?? []).some((block) => worksOnPath(block, files, root)))) kept.push(...lines.slice(from, i));
    from = i;
  }
  return kept.join("\n");
}

/**
 * The records of a compact transcript that belong to one checkpoint. The
 * transcript ends where this checkpoint was made; the question is where it
 * starts. `sinceWindow` skips what the previous checkpoint of the same
 * session read (`read`), when this transcript extends that snapshot: its
 * first `read.lines` lines hash to `read.hash`. Otherwise the transcript is
 * this checkpoint's own and is read whole. The commit's own turn starts at
 * the last prompt a person typed before its first tool call that works on
 * one of `files` inside the new part, or before the new part when it holds
 * none (a commit the same step made). `turnWindow` is that turn whole, so a
 * run the turn made before an earlier commit still counts and a run from an
 * earlier turn does not; `stepWindow` is the turn's part inside
 * `sinceWindow`. Lines that are not JSON are kept; every reader skips them.
 */
export function windowsOf(transcript: string, read: ReadSession | undefined, files: string[]): Windows {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  const records = lines.map((line): TranscriptRecord | undefined => {
    try {
      return JSON.parse(line) as TranscriptRecord;
    } catch {
      return undefined;
    }
  });
  const extended = read !== undefined && read.lines <= lines.length && transcriptHash(lines.slice(0, read.lines)) === read.hash;
  const sinceStart = extended ? read.lines : 0;
  // The commit's own turn: back from its first work on the files inside the new part (or from the part's start) to the last prompt a person typed.
  const firstWork = records.findIndex((r, i) => i >= sinceStart && r?.type === "assistant" && (r.content ?? []).some((block) => worksOn(block, files)));
  let turnStart = firstWork === -1 ? sinceStart : firstWork;
  while (turnStart > 0 && !(records[turnStart] !== undefined && humanTurn(records[turnStart]!))) turnStart--;
  const stepStart = Math.max(sinceStart, turnStart);
  // What was asked: the turn's opening prompt. With no work on the files, the commit closes the
  // transcript's last turn, so the last prompt in the new part, else (the same step as an earlier
  // commit) the turn it continues; with nothing read before either, the turn is unknown.
  let opening: TranscriptRecord | undefined;
  if (firstWork !== -1) opening = records[turnStart];
  else if (extended) {
    let last = records.length - 1;
    while (last >= sinceStart && !(records[last] !== undefined && humanTurn(records[last]!))) last--;
    opening = records[last >= sinceStart ? last : turnStart];
  }
  return {
    ask: opening !== undefined && humanTurn(opening) ? askOf(opening) : "",
    worked: firstWork !== -1,
    decisionWindow: firstWork === -1 ? "" : workingTurns(lines, records, stepStart, files),
    opensTurn: turnStart >= sinceStart,
    sinceWindow: lines.slice(sinceStart).join("\n"),
    stepWindow: lines.slice(stepStart).join("\n"),
    turnWindow: lines.slice(turnStart).join("\n"),
    lines: lines.length,
    hash: transcriptHash(lines),
    extended,
  };
}

/** What the agent said in a compact transcript: its first and last text, and how much it did. A line that is not JSON is skipped. */
export function narrationIn(transcript: string): Narration {
  let started = "";
  let ended = "";
  let texts = 0;
  let tools = 0;
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (record.type !== "assistant") continue;
    for (const block of record.content ?? []) {
      if (block.type === "tool_use") tools++;
      if (block.type !== "text" || typeof block.text !== "string" || block.text.trim() === "") continue;
      texts++;
      const first = promptLine(block.text);
      if (started === "") started = first;
      ended = first;
    }
  }
  return { started, ended: ended === started ? "" : ended, texts, tools };
}

/** The Bash commands in a compact transcript that run a test runner, in order, deduplicated. A line that is not JSON is skipped. */
export function testCommandsIn(transcript: string): string[] {
  const seen = new Set<string>();
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    for (const block of record.content ?? []) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      const command = block.input?.command;
      if (typeof command === "string" && TEST_RUNNER.test(command)) seen.add(command);
    }
  }
  return [...seen];
}

/**
 * Resolve a commit's `Entire-Checkpoint:` trailer to its checkpoint and
 * return the allowlisted subset. Undefined when the commit has no trailer,
 * names a checkpoint that is not in this repository (checkpoints are pushed
 * separately from the branch; `checkpointTrailer` still reports the id so the
 * brief can say it is missing rather than that there was none), or names one
 * whose files cannot be read or parsed. Never throws.
 *
 * `symbols` are the changed symbols the brief already knows; the transcript's
 * edits are matched to them and their text is searched, never shown.
 *
 * `read` is what earlier checkpoints in the range already read per session
 * and `files` what the commit changed (`changed`, what the whole range
 * changed, is where design notes the agent wrote may land); `windowsOf` uses them to read this
 * commit's part of a cumulative transcript, not the whole session's.
 *
 * The paths read are Entire's layout, spelled out here: `<i>/metadata.json`,
 * `<i>/transcript.jsonl` and, when present, `<i>/prompt.txt` per session, `metadata.json` at
 * the root, under the place `checkpointPlaces` names for the id's shape.
 * `metadata.json` also lists per-session paths; those are not followed, so no
 * checkpoint can point this reader at `<i>/full.jsonl`.
 */
export function checkpointFor(repo: string, commit: string, symbols: SymbolAt[] = [], read: ReadSessions = new Map(), files: string[] = [], changed: string[] = []): Checkpoint | undefined {
  const id = checkpointTrailer(repo, commit);
  if (id === undefined) return undefined;
  const place = checkpointPlace(repo, id);
  if (place === undefined) return undefined;
  const show = (path: string): string => git(repo, ["show", `${place.ref}:${place.prefix}${path}`]);
  try {
    const meta = JSON.parse(show("metadata.json")) as CheckpointMetadata;
    const sessionCount = Math.max(1, meta.sessions?.length ?? 1);
    const session = JSON.parse(show("0/metadata.json")) as SessionMetadata;
    // Entire does not write `prompt.txt` for every session (25 of 250 checkpoints on
    // turing-webapp's branch have none under `0/`), so its absence costs only the line.
    const typed = (i: number): string => {
      try {
        return promptLine(show(`${i}/prompt.txt`));
      } catch {
        return "";
      }
    };
    // The ask of a session that worked on the commit's files wins over one that only ran alongside.
    let ask = "";
    let askWorked = false;
    const decisions: Decision[] = [];
    const testCommands = new Set<string>();
    let narration: Narration = { started: "", ended: "", texts: 0, tools: 0 };
    const sessions: CheckpointSession[] = [];
    let readBefore = 0;
    const reasons = new Map<string, SymbolReason>();
    const committed = new Map<string, string | undefined>();
    const contents = (path: string): string | undefined => {
      if (!committed.has(path)) {
        try {
          committed.set(path, git(repo, ["show", `${commit}:${path}`]));
        } catch {
          committed.set(path, undefined);
        }
      }
      return committed.get(path);
    };
    for (let i = 0; i < sessionCount; i++) {
      const sessionId = (i === 0 ? session : (JSON.parse(show(`${i}/metadata.json`)) as SessionMetadata)).session_id ?? "";
      const before = sessionId === "" ? undefined : read.get(sessionId);
      const { sinceWindow, stepWindow, turnWindow, lines, hash, extended, ask: opened, worked, decisionWindow, opensTurn } = windowsOf(show(`${i}/transcript.jsonl`), before, files);
      decisions.push(...decisionsIn(decisionWindow, changed.length > 0 ? changed : files, opensTurn));
      if (opened !== "" && (ask === "" || (worked && !askWorked))) {
        ask = opened;
        askWorked = worked;
      }
      if (extended) readBefore++;
      sessions.push({ id: sessionId, lines, hash });
      for (const c of testCommandsIn(turnWindow)) testCommands.add(c);
      for (const r of symbolReasonsIn(sinceWindow, symbols, contents)) reasons.set(`${r.path}\0${r.label}`, r);
      const n = narrationIn(stepWindow);
      narration = {
        started: narration.started || n.started,
        ended: n.texts > 0 ? n.ended || n.started : narration.ended,
        texts: narration.texts + n.texts,
        tools: narration.tools + n.tools,
      };
    }
    if (narration.ended === narration.started) narration.ended = "";
    let prompt = ask;
    for (let i = 0; prompt === "" && i < sessionCount; i++) prompt = typed(i);
    // The same step: every session's transcript extends what an earlier commit read, and nothing came after.
    const sameStep = readBefore > 0 && readBefore === sessions.length && narration.texts === 0 && narration.tools === 0 ? read.get(sessions[0]!.id)?.sha : undefined;
    return {
      id,
      commit: git(repo, ["rev-parse", `${commit}^{commit}`]).trim(),
      agent: session.agent ?? "",
      model: session.model ?? "",
      prompt,
      narration,
      sessions,
      ...(sameStep !== undefined && { sameStepAs: sameStep }),
      filesTouched: meta.files_touched ?? [],
      testCommands: [...testCommands],
      source: meta.source ?? "entire",
      reasons: [...reasons.values()],
      decisions,
    };
  } catch {
    return undefined;
  }
}
