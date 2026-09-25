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
}

const TRAILER = /^Entire-Checkpoint:\s*([0-9A-Z]{26})\s*$/m;

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
  content?: { type?: string; name?: string; input?: { command?: unknown } }[];
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
 * The paths read are Entire's layout, spelled out here: `<i>/metadata.json`,
 * `<i>/prompt.txt` and `<i>/transcript.jsonl` per session, `metadata.json` at
 * the root. `metadata.json` also lists per-session paths; those are not
 * followed, so no checkpoint can point this reader at `<i>/full.jsonl`.
 */
export function checkpointFor(repo: string, commit: string): Checkpoint | undefined {
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
    for (let i = 0; i < sessionCount; i++) {
      for (const c of testCommandsIn(show(`${i}/transcript.jsonl`))) testCommands.add(c);
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
    };
  } catch {
    return undefined;
  }
}
