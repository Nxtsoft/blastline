import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Checkpoint } from "./checkpoint.js";

/**
 * The fleet's session index (agents-cli), read-only. One row per agent session
 * across every harness on the machine; `session_timelines.state_json` carries
 * the agent's own narration as timestamped steps. Measured on mars 2026-09-24:
 * 13,145 sessions (codex 4,772 / claude 4,308 / droid 4,065), 868 with a
 * timeline, `tool_calls` indexed only up to 2026-09-18.
 */
export const DEFAULT_SESSIONS_DB = join(homedir(), ".agents", ".history", "sessions", "sessions.db");

export interface FleetSession {
  id: string;
  agent: string;
  model?: string;
  cwd: string;
  startedAt: string;
  lastActivity: string;
  ticketId?: string;
  prNumber?: number;
  firstUserMessage?: string;
}

/**
 * One narration step of a session timeline. Shape as stored in
 * `session_timelines.state_json.steps[]` (real row, session 7182303c):
 * `{"text":"Three things in parallel now: …","at":"2026-09-24T16:23:42.…Z",
 *   "endedAt":"2026-09-24T16:24:41.…Z","source":"narration","tools":6,
 *   "failed":0,"blocked":0,"mix":{"git":1,"test":1,"edit":2,"run":2,"read":1}}`
 */
export interface TimelineStep {
  text: string;
  at: string;
  endedAt: string;
  source: string;
  tools?: number;
  mix?: Record<string, number>;
  marks?: string[];
  /** true when the step's window contains the asked-for time; false when it is the nearest earlier step */
  covering: boolean;
}

/** What the fleet index knows about the moment a commit was made. */
export interface CommitIntent {
  commit: string;
  committedAt: string;
  session: FleetSession;
  step?: TimelineStep;
  testCommands: string[];
}

const TEST_RUNNER = /\b(vitest|jest|pytest|go test|cargo test|ctest|gradlew? test|bun test|npm test)\b/;

interface SessionRow {
  id: string;
  agent: string;
  model: string | null;
  cwd: string;
  timestamp: string;
  last_activity: string;
  ticket_id: string | null;
  pr_number: number | null;
  first_user_message: string | null;
}

function toSession(r: SessionRow): FleetSession {
  const s: FleetSession = { id: r.id, agent: r.agent, cwd: r.cwd, startedAt: r.timestamp, lastActivity: r.last_activity };
  if (r.model) s.model = r.model;
  if (r.ticket_id) s.ticketId = r.ticket_id;
  if (r.pr_number !== null) s.prNumber = r.pr_number;
  if (r.first_user_message) s.firstUserMessage = r.first_user_message;
  return s;
}

export class SessionsIndex {
  private readonly db: DatabaseSync;

  /** Opens the index read-only. Throws a plain Error naming the path when there is no such file. */
  constructor(path: string = DEFAULT_SESSIONS_DB) {
    if (!existsSync(path)) throw new Error(`no fleet session index at ${path} (agents-cli writes it; pass --sessions-db to point elsewhere)`);
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  /**
   * Sessions that were working in `dir` or below it (their cwd, or a directory
   * they touched; agent worktrees live under `<repo>/.agents/worktrees/`) and
   * were alive at `at` (ISO, UTC). Most recently active first.
   */
  sessionsAt(dir: string, at: string): FleetSession[] {
    const rows = this.db
      .prepare(
        `select id, agent, model, cwd, timestamp, last_activity, ticket_id, pr_number, first_user_message
           from sessions
          where (cwd = ? or cwd like ?
                 or instr(coalesce(recent_directories_touched, ''), ?) > 0
                 or instr(coalesce(recent_directories_touched, ''), ?) > 0)
            and timestamp <= ? and last_activity >= ?
          order by last_activity desc`,
      )
      .all(dir, `${dir}/%`, JSON.stringify(dir), `${JSON.stringify(dir).slice(0, -1)}/`, at, at) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** One session by id, alive at `at`, or undefined. */
  sessionAt(id: string, at: string): FleetSession | undefined {
    const row = this.db
      .prepare(
        `select id, agent, model, cwd, timestamp, last_activity, ticket_id, pr_number, first_user_message
           from sessions where id = ? and timestamp <= ? and last_activity >= ?`,
      )
      .get(id, at, at) as unknown as SessionRow | undefined;
    return row && toSession(row);
  }

  /**
   * Session ids whose indexed text mentions a token starting with `needle` (a
   * short sha, a branch, a path): the per-call index first, then the
   * session-level text index, which covers sessions the call index has not
   * reached (on mars the call index stopped at 2026-09-18).
   */
  sessionsMentioning(needle: string): string[] {
    const q = `"${needle.replace(/"/g, '""')}"*`;
    const calls = this.ftsIds(
      `select distinct tc.session_id as session_id
         from tool_call_text t join tool_calls tc on tc.call_key = t.call_key
        where tool_call_text match ?`,
      q,
    );
    const text = this.ftsIds(`select distinct session_id from session_text where session_text match ?`, q);
    return [...new Set([...calls, ...text])];
  }

  /**
   * One FTS index's answer, or none when that index cannot answer: the table
   * is absent in an older index, or the FTS content table is missing rows
   * (mars, 2026-09-25: "fts5: missing row 237052 from content table"). The
   * join is an optimisation over the directory candidates; a broken index
   * must not stop the brief.
   */
  private ftsIds(sql: string, q: string): string[] {
    try {
      return (this.db.prepare(sql).all(q) as unknown as { session_id: string }[]).map((r) => r.session_id);
    } catch {
      return [];
    }
  }

  /**
   * The narration step whose window contains `at`; otherwise the nearest step
   * that started before it, flagged `covering: false`. Undefined when the
   * session has no timeline (868 of 13,145 sessions had one on 2026-09-24).
   */
  stepCovering(sessionId: string, at: string): TimelineStep | undefined {
    const row = this.db
      .prepare(`select state_json from session_timelines where session_id = ?`)
      .get(sessionId) as unknown as { state_json: string } | undefined;
    if (!row) return undefined;
    const steps = (JSON.parse(row.state_json) as { steps?: Omit<TimelineStep, "covering">[] }).steps ?? [];
    const narrated = steps.filter((s) => s.source === "narration" || s.source === "user");
    const covering = narrated.filter((s) => s.at <= at && at <= (s.endedAt ?? s.at));
    const pick = covering.at(-1) ?? narrated.filter((s) => s.at <= at).at(-1);
    return pick && { ...pick, covering: covering.length > 0 };
  }

  /** Test-runner commands the session ran in [from, to], in order. */
  testCommands(sessionId: string, from: string, to: string): string[] {
    const rows = this.db
      .prepare(
        `select input from tool_calls
          where session_id = ? and tool in ('Bash', 'exec', 'Execute') and timestamp between ? and ?
          order by timestamp`,
      )
      .all(sessionId, from, to) as unknown as { input: string }[];
    return rows.flatMap((r) => commandsOf(r.input)).filter((c) => TEST_RUNNER.test(c));
  }
}

/**
 * The shell commands inside one indexed tool-call input. Three real shapes
 * (sessions.db on mars, 2026-09-24):
 * - Claude `Bash`: `{"command":"bunx vitest run","description":"…"}`
 * - Droid `Execute`: the bare command string, not JSON
 * - Codex `exec`: `{"input":"text(await tools.exec_command({cmd:\"bunx vitest run\"}))\n"}`,
 *   a JS program whose every `exec_command({cmd: <string literal>` is one command
 */
export function commandsOf(input: string): string[] {
  let parsed: { command?: unknown; cmd?: unknown; input?: unknown };
  try {
    parsed = JSON.parse(input) as typeof parsed;
  } catch {
    return [input];
  }
  if (typeof parsed.command === "string") return [parsed.command];
  if (typeof parsed.cmd === "string") return [parsed.cmd];
  if (Array.isArray(parsed.command)) return [parsed.command.join(" ")];
  if (typeof parsed.input === "string") return execCommandsIn(parsed.input);
  return [];
}

const EXEC_CMD = /exec_command\(\{[^}]*?\bcmd:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function execCommandsIn(program: string): string[] {
  const out: string[] = [];
  for (const m of program.matchAll(EXEC_CMD)) out.push(decodeJsString(m[1]!));
  return out;
}

/** A JS string literal (double, single or backtick quoted) to its value; template expressions stay literal. */
function decodeJsString(literal: string): string {
  const body = literal.slice(1, -1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    switch (esc[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "u": return String.fromCharCode(parseInt(esc.slice(1), 16));
      case "x": return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc;
    }
  });
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * When the commit was made, as ISO UTC, the form the index stores: the author
 * date, which a rebase-merge keeps while it replaces the committer date with
 * the merge time.
 */
export function commitTime(repo: string, sha: string): string {
  return new Date(git(repo, ["log", "-1", "--format=%aI", sha])).toISOString();
}

/**
 * The repository's main working tree, so sessions in any of its linked
 * worktrees (`<repo>/.agents/worktrees/<slug>`) count as working in it.
 */
export function repositoryRoot(repo: string): string {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : git(repo, ["rev-parse", "--show-toplevel"]);
}

/** Where a checkpoint-shaped intent came from when no ref exists: the fleet index on this machine. */
export const LOCAL_SOURCE = "sessions.db";

/**
 * A commit's intent from the fleet index, in the shape the brief reads from a
 * checkpoint ref, for `blastline brief --local` on the agent machine. No ref
 * is written and nothing leaves the machine; `id` is empty because there is
 * no trailer. `filesTouched` is what the commit changed.
 */
export function localCheckpoint(index: SessionsIndex, repo: string, sha: string, files: string[]): Checkpoint | undefined {
  const intent = fleetIntent(index, repo, sha);
  if (!intent) return undefined;
  return {
    id: "",
    commit: git(repo, ["rev-parse", `${sha}^{commit}`]),
    agent: intent.session.agent,
    model: intent.session.model ?? "",
    prompt: (intent.step?.text ?? intent.session.firstUserMessage ?? "").split("\n")[0]!.slice(0, 200),
    filesTouched: files,
    testCommands: intent.testCommands,
    source: LOCAL_SOURCE,
  };
}

/**
 * The intent behind one commit, from the fleet index alone: the session that
 * was working in `repo` when the commit was made (a session whose indexed
 * tool calls mention the sha wins over a merely co-located one), the
 * narration step covering the commit time, and the test commands that session
 * ran during that step. Undefined when no session was alive there.
 */
export function fleetIntent(index: SessionsIndex, repo: string, sha: string): CommitIntent | undefined {
  const committedAt = commitTime(repo, sha);
  const candidates = index.sessionsAt(repositoryRoot(repo), committedAt);
  const mentioning = index
    .sessionsMentioning(sha.slice(0, 7))
    .map((id) => candidates.find((s) => s.id === id) ?? index.sessionAt(id, committedAt))
    .filter((s): s is FleetSession => s !== undefined);
  const session = mentioning[0] ?? candidates[0];
  if (!session) return undefined;
  const step = index.stepCovering(session.id, committedAt);
  const from = step?.at ?? session.startedAt;
  const to = step?.endedAt ?? committedAt;
  const intent: CommitIntent = { commit: sha, committedAt, session, testCommands: index.testCommands(session.id, from, to) };
  if (step) intent.step = step;
  return intent;
}
