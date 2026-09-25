import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { CommitIntent } from "./sessions.js";

/**
 * Writes a checkpoint for a commit in the layout the Entire CLI uses
 * (github.com/entireio/cli, MIT), so one reader serves both writers:
 *
 *   refs/entire/checkpoints/<last 2 chars of id>/<id>  -> commit whose tree is
 *     metadata.json            {cli_version, checkpoint_id, strategy, source, branch, files_touched, ticket_id, sessions[]}
 *     0/metadata.json          {session_id, agent, model, created_at, turn_id, files_touched}
 *     0/prompt.txt             the intent line (a narration step, or the session's first message)
 *     0/transcript.jsonl       compact records, one per test command the session ran in that step
 *     0/content_hash.txt       sha256 of transcript.jsonl
 *
 * and the commit carries an `Entire-Checkpoint: <id>` trailer. Probed on
 * 2026-09-24 against Entire CLI 0.11.2: id 01M3AY9296319GSPWRKXGHXMH5 lived at
 * refs/entire/checkpoints/H5/01M3AY9296319GSPWRKXGHXMH5 with exactly these
 * six paths.
 */
export const CHECKPOINT_SOURCE = "blastline";

export interface WrittenCheckpoint {
  id: string;
  ref: string;
  /** the commit the trailer was written to; differs from the input sha when HEAD was amended */
  commit: string;
  trailerWritten: boolean;
}

export interface WriteOptions {
  /** blastline's own version, recorded as cli_version */
  version: string;
  /**
   * Add the `Entire-Checkpoint` trailer by amending. Only HEAD can be amended,
   * and only while no remote-tracking branch contains it; otherwise the ref is
   * written and the trailer is skipped, reported in the result.
   */
  trailer?: boolean;
  now?: Date;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 chars of time, 16 of randomness, Crockford base32, like Entire's ids. */
export function ulid(now: Date = new Date()): string {
  let ms = now.getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const rand = randomBytes(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i]! % 32];
  return time + tail;
}

export function refFor(id: string): string {
  return `refs/entire/checkpoints/${id.slice(-2)}/${id}`;
}

function git(repo: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", ...(input === undefined ? {} : { input }), ...(env === undefined ? {} : { env }) }).trim();
}

/**
 * The identity the checkpoint commits carry. The repo's configured user when
 * there is one; otherwise a fixed blastline identity, so a CI runner or a
 * fresh agent machine without git config can still write the ref.
 */
function identity(repo: string): NodeJS.ProcessEnv {
  const email = execFileSync("git", ["-C", repo, "config", "--get", "--default", "", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (email !== "" || process.env["GIT_COMMITTER_EMAIL"]) return process.env;
  const fixed = { GIT_AUTHOR_NAME: "blastline", GIT_AUTHOR_EMAIL: "blastline@checkpoint", GIT_COMMITTER_NAME: "blastline", GIT_COMMITTER_EMAIL: "blastline@checkpoint" };
  return { ...process.env, ...fixed };
}

function blob(repo: string, content: string): string {
  return git(repo, ["hash-object", "-w", "--stdin"], content);
}

function tree(repo: string, entries: { name: string; kind: "blob" | "tree"; oid: string }[]): string {
  const lines = entries.map((e) => `${e.kind === "blob" ? "100644 blob" : "040000 tree"} ${e.oid}\t${e.name}`).join("\n") + "\n";
  return git(repo, ["mktree"], lines);
}

/** Compact transcript record for one tool call, the subset Entire's compact transcript carries. */
function compactRecord(agent: string, version: string, ts: string, command: string): string {
  return JSON.stringify({
    v: 1,
    agent,
    cli_version: version,
    type: "assistant",
    ts,
    content: [{ type: "tool_use", name: "Bash", input: { command } }],
  });
}

function filesTouched(repo: string, sha: string): string[] {
  const out = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]);
  return out === "" ? [] : out.split("\n");
}

function isPushed(repo: string, sha: string): boolean {
  return git(repo, ["branch", "-r", "--contains", sha]) !== "";
}

/**
 * Write the checkpoint ref for `sha` from what the fleet index knew, and (when
 * asked and safe) the trailer on the commit. Idempotent per call: every call
 * mints a new id; callers check for an existing trailer first.
 */
export function writeCheckpoint(repo: string, sha: string, intent: CommitIntent | undefined, opts: WriteOptions): WrittenCheckpoint {
  const now = opts.now ?? new Date();
  const id = ulid(now);
  const ref = refFor(id);
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const files = filesTouched(repo, sha);
  const agent = intent?.session.agent ?? "unknown";
  const transcript = (intent?.testCommands ?? []).map((c) => compactRecord(agent, opts.version, intent?.committedAt ?? now.toISOString(), c)).join("\n");
  const prompt = intent?.step?.text ?? intent?.session.firstUserMessage ?? "";

  const sessionMeta = {
    session_id: intent?.session.id ?? null,
    agent,
    model: intent?.session.model ?? null,
    created_at: now.toISOString(),
    turn_id: intent?.step?.at ?? null,
    step_covers_commit: intent?.step?.covering ?? false,
    files_touched: files,
  };
  const metadata = {
    cli_version: `${CHECKPOINT_SOURCE}/${opts.version}`,
    checkpoint_id: id,
    strategy: "manual-commit",
    source: CHECKPOINT_SOURCE,
    branch,
    checkpoints_count: 1,
    files_touched: files,
    ticket_id: intent?.session.ticketId ?? null,
    sessions: [
      {
        metadata: "/0/metadata.json",
        compact_transcript: "/0/transcript.jsonl",
        content_hash: "/0/content_hash.txt",
        prompt: "/0/prompt.txt",
      },
    ],
  };

  const inner = tree(repo, [
    { name: "content_hash.txt", kind: "blob", oid: blob(repo, `sha256:${createHash("sha256").update(transcript).digest("hex")}\n`) },
    { name: "metadata.json", kind: "blob", oid: blob(repo, JSON.stringify(sessionMeta, null, 2) + "\n") },
    { name: "prompt.txt", kind: "blob", oid: blob(repo, prompt + "\n") },
    { name: "transcript.jsonl", kind: "blob", oid: blob(repo, transcript === "" ? "" : transcript + "\n") },
  ]);
  const root = tree(repo, [
    { name: "0", kind: "tree", oid: inner },
    { name: "metadata.json", kind: "blob", oid: blob(repo, JSON.stringify(metadata, null, 2) + "\n") },
  ]);
  const env = identity(repo);
  const commit = git(repo, ["commit-tree", root, "-m", `checkpoint ${id} for ${sha.slice(0, 7)}`], undefined, env);
  git(repo, ["update-ref", ref, commit]);

  let trailerWritten = false;
  let target = git(repo, ["rev-parse", sha]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (opts.trailer && target === head && !isPushed(repo, head)) {
    git(repo, ["commit", "--amend", "--no-edit", "--no-verify", "--trailer", `Entire-Checkpoint: ${id}`], undefined, env);
    target = git(repo, ["rev-parse", "HEAD"]);
    trailerWritten = true;
  }
  return { id, ref, commit: target, trailerWritten };
}
