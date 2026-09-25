import { execFileSync } from "node:child_process";

/**
 * The reviewable subset of an Entire checkpoint (github.com/entireio/cli): the
 * fields the PR brief may show. This is the privacy allowlist. A checkpoint ref
 * also carries the raw agent transcript (`0/full.jsonl`), which embeds hook
 * output, session paths and pasted user context; nothing here reads it.
 */
export interface Checkpoint {
  /** The ULID from the commit's `Entire-Checkpoint:` trailer. */
  id: string;
  /** Full sha of the commit that carries the trailer. */
  commit: string;
  /** `0/metadata.json.agent`, e.g. "Claude Code". */
  agent: string;
  /** `0/metadata.json.model`, e.g. "claude-sonnet-5". */
  model: string;
  /** First line of `0/prompt.txt`, at most 200 characters. */
  prompt: string;
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

const TRAILER = /^Entire-Checkpoint:\s*([0-9A-Z]{26})\s*$/m;

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
 * The line of a prompt that states the intent, capped at 200 characters: the
 * first non-blank line that is not the harness preamble a session launched
 * through `agents run` starts with ("You are in a git worktree of <repo> on
 * branch <b>…", one line), so the reviewer sees the first line the human wrote.
 */
export function promptLine(prompt: string): string {
  const line = prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("You are in a git worktree of "));
  return (line ?? "").slice(0, 200);
}

/** The checkpoint id a commit's trailer names, or undefined when it carries none. */
export function checkpointTrailer(repo: string, commit: string): string | undefined {
  return TRAILER.exec(git(repo, ["log", "-1", "--format=%B", commit]))?.[1];
}

/** Where Entire stores a checkpoint: sharded by the last two characters of its id. */
export function checkpointRef(id: string): string {
  return `refs/entire/checkpoints/${id.slice(-2)}/${id}`;
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
 * Resolve a commit's `Entire-Checkpoint:` trailer to its checkpoint ref and
 * return the allowlisted subset. Undefined when the commit has no trailer,
 * names a checkpoint whose ref is not in this repository (the refs are pushed
 * separately from the branch; `checkpointTrailer` still reports the id so the
 * brief can say the ref is missing rather than that there was no checkpoint),
 * or names one whose files cannot be read or parsed. Never throws.
 *
 * `symbols` are the changed symbols the brief already knows; the transcript's
 * edits are matched to them and their text is searched, never shown.
 *
 * The paths read are Entire's layout, spelled out here: `<i>/metadata.json`,
 * `<i>/prompt.txt` and `<i>/transcript.jsonl` per session, `metadata.json` at
 * the root. `metadata.json` also lists per-session paths; those are not
 * followed, so no checkpoint can point this reader at `<i>/full.jsonl`.
 */
export function checkpointFor(repo: string, commit: string, symbols: SymbolAt[] = []): Checkpoint | undefined {
  const id = checkpointTrailer(repo, commit);
  if (id === undefined) return undefined;
  const ref = checkpointRef(id);
  const show = (path: string): string => git(repo, ["show", `${ref}:${path}`]);
  try {
    const meta = JSON.parse(show("metadata.json")) as CheckpointMetadata;
    const sessionCount = Math.max(1, meta.sessions?.length ?? 1);
    const session = JSON.parse(show("0/metadata.json")) as SessionMetadata;
    const prompt = promptLine(show("0/prompt.txt"));
    const testCommands = new Set<string>();
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
      const transcript = show(`${i}/transcript.jsonl`);
      for (const c of testCommandsIn(transcript)) testCommands.add(c);
      for (const r of symbolReasonsIn(transcript, symbols, contents)) reasons.set(`${r.path}\0${r.label}`, r);
    }
    return {
      id,
      commit: git(repo, ["rev-parse", `${commit}^{commit}`]).trim(),
      agent: session.agent ?? "",
      model: session.model ?? "",
      prompt,
      filesTouched: meta.files_touched ?? [],
      testCommands: [...testCommands],
      source: meta.source ?? "entire",
      reasons: [...reasons.values()],
    };
  } catch {
    return undefined;
  }
}
