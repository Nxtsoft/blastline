import { execFileSync } from "node:child_process";

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
  /** `0/metadata.json.session_id`; "" when the writer set none. */
  sessionId: string;
  /** `0/metadata.json.created_at`, ISO; "" when the writer set none. */
  createdAt: string;
  /** The first line a human wrote in `0/prompt.txt`, at most 200 characters. */
  prompt: string;
  /** What the agent said in the transcript window that ends at this checkpoint. */
  narration: Narration;
  /** Set by the brief when the window since the previous checkpoint of the same session holds no text and no tool call: the commit that step also produced. */
  sameStepAs?: string;
  /** `metadata.json.files_touched`, repo-relative. */
  filesTouched: string[];
  /** Bash tool calls in the compact transcript whose command names a test runner. */
  testCommands: string[];
  /** `metadata.json.source` when a writer sets one; Entire's own hooks do not, so "entire". */
  source: string;
  /** Why each changed symbol the caller asked about changed, when an edit in the transcript touched it. */
  reasons: SymbolReason[];
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

/**
 * What the agent said in the part of the compact transcript that belongs to
 * one checkpoint. Entire's branch backend keeps one cumulative transcript per
 * session, so the brief windows it between consecutive checkpoints of the
 * same session; the ref backend writes one per commit, so the window is all
 * of it.
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
 * The line of a prompt that states the intent, capped at 200 characters.
 * `0/prompt.txt` holds every prompt of the turn, separated by `---` lines. A
 * prompt that starts with a tag (`<task-notification>`, `<system-reminder>`)
 * was delivered by the harness, not typed by a person, and is skipped whole;
 * so is the preamble a session launched through `agents run` starts with
 * ("You are in a git worktree of <repo> on branch <b>…", one line). The
 * reviewer sees the first line a human wrote.
 */
export function promptLine(prompt: string): string {
  for (const block of prompt.split(/^---\s*$/m)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("You are in a git worktree of "));
    const first = lines[0];
    if (first === undefined || first.startsWith("<")) continue;
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
  created_at?: string;
}

/** One record of the compact transcript: a turn with its content blocks. */
interface TranscriptRecord {
  type?: string;
  /** ISO time of the turn; Entire 0.10.0 and later stamp every record. */
  ts?: string;
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
  /** From the turn in which the commit's files were first edited: where the narration and the test runs come from. */
  stepWindow: string;
}

/**
 * Whether a user record carries text a person typed. The harness delivers
 * its own text as user records too: a tag (`<task-notification>`,
 * `<system-reminder>`), or a skill's instructions, which Claude Code injects
 * starting "Base directory for this skill:".
 */
function humanTurn(record: TranscriptRecord): boolean {
  if (record.type !== "user") return false;
  const text = record.content?.find((c) => typeof c.text === "string")?.text?.trim() ?? "";
  return text !== "" && !text.startsWith("<") && !text.startsWith("Base directory for this skill:");
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
 * The records of a compact transcript that belong to one checkpoint. Entire's
 * branch backend keeps one cumulative transcript per session and snapshots it
 * at each checkpoint, so the transcript ends where this checkpoint was made
 * and the question is where it starts. `sinceWindow` starts after `since`,
 * the previous checkpoint of the same session (a record without a stamp is
 * kept, so an unstamped transcript is read whole). `stepWindow` starts at the
 * later of that and the last prompt a person typed before the first tool call
 * that works on one of `files`, so a session's earlier, unrelated turns do
 * not read as this commit's intent. Lines that are not JSON are kept; every
 * reader skips them.
 */
export function windowsOf(transcript: string, since: string | undefined, files: string[]): Windows {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  const records = lines.map((line): TranscriptRecord | undefined => {
    try {
      return JSON.parse(line) as TranscriptRecord;
    } catch {
      return undefined;
    }
  });
  let sinceStart = 0;
  if (since !== undefined) {
    const first = records.findIndex((r) => r === undefined || typeof r.ts !== "string" || r.ts > since);
    sinceStart = first === -1 ? lines.length : first;
  }
  let stepStart = sinceStart;
  const firstEdit = records.findIndex((r, i) => i >= sinceStart && r?.type === "assistant" && (r.content ?? []).some((block) => worksOn(block, files)));
  if (firstEdit !== -1) {
    let turn = firstEdit;
    while (turn > sinceStart && !(records[turn] !== undefined && humanTurn(records[turn]!))) turn--;
    stepStart = turn;
  }
  return { sinceWindow: lines.slice(sinceStart).join("\n"), stepWindow: lines.slice(stepStart).join("\n") };
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

/** The checkpoint that came before this one in the same brief: where its window starts. */
export interface PreviousCheckpoint {
  sha: string;
  sessionId: string;
  createdAt: string;
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
 * `previous` is the brief's previous checkpoint and `files` what the commit
 * changed; `windowsOf` uses them to read this commit's part of a cumulative
 * transcript, not the whole session's.
 *
 * The paths read are Entire's layout, spelled out here: `<i>/metadata.json`,
 * `<i>/prompt.txt` and `<i>/transcript.jsonl` per session, `metadata.json` at
 * the root, under the place `checkpointPlaces` names for the id's shape.
 * `metadata.json` also lists per-session paths; those are not followed, so no
 * checkpoint can point this reader at `<i>/full.jsonl`.
 */
export function checkpointFor(repo: string, commit: string, symbols: SymbolAt[] = [], previous?: PreviousCheckpoint, files: string[] = []): Checkpoint | undefined {
  const id = checkpointTrailer(repo, commit);
  if (id === undefined) return undefined;
  const place = checkpointPlace(repo, id);
  if (place === undefined) return undefined;
  const show = (path: string): string => git(repo, ["show", `${place.ref}:${place.prefix}${path}`]);
  try {
    const meta = JSON.parse(show("metadata.json")) as CheckpointMetadata;
    const sessionCount = Math.max(1, meta.sessions?.length ?? 1);
    const session = JSON.parse(show("0/metadata.json")) as SessionMetadata;
    const sessionId = session.session_id ?? "";
    const createdAt = session.created_at ?? "";
    const since = previous !== undefined && previous.sessionId !== "" && previous.sessionId === sessionId ? previous.createdAt : undefined;
    const prompt = promptLine(show("0/prompt.txt"));
    const testCommands = new Set<string>();
    let narration: Narration = { started: "", ended: "", texts: 0, tools: 0 };
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
      const { sinceWindow, stepWindow } = windowsOf(show(`${i}/transcript.jsonl`), since, files);
      for (const c of testCommandsIn(stepWindow)) testCommands.add(c);
      for (const r of symbolReasonsIn(sinceWindow, symbols, contents)) reasons.set(`${r.path}\0${r.label}`, r);
      const n = narrationIn(stepWindow);
      if (i === 0) narration = n;
      else narration = { started: narration.started || n.started, ended: n.ended || narration.ended, texts: narration.texts + n.texts, tools: narration.tools + n.tools };
    }
    return {
      id,
      commit: git(repo, ["rev-parse", `${commit}^{commit}`]).trim(),
      agent: session.agent ?? "",
      model: session.model ?? "",
      sessionId,
      createdAt,
      prompt,
      narration,
      ...(since !== undefined && previous !== undefined && narration.texts === 0 && narration.tools === 0 && { sameStepAs: previous.sha }),
      filesTouched: meta.files_touched ?? [],
      testCommands: [...testCommands],
      source: meta.source ?? "entire",
      reasons: [...reasons.values()],
    };
  } catch {
    return undefined;
  }
}
