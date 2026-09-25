import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SessionsIndex, commitTime, fleetIntent } from "./sessions.js";

/**
 * A sessions.db with the exact column subset the reader touches, populated
 * with the real shapes observed on mars on 2026-09-24: session 7182303c's
 * timeline steps around Nxtsoft/blastline PR #31's commits.
 */
function fixtureDb(dir: string, cwd: string): string {
  const path = join(dir, "sessions.db");
  const db = new DatabaseSync(path);
  db.exec(`
    create table sessions (id text primary key, agent text, model text, cwd text, timestamp text, last_activity text,
                           ticket_id text, pr_number integer, first_user_message text, recent_directories_touched text);
    create table session_timelines (session_id text primary key, state_json text);
    create table tool_calls (call_key text primary key, session_id text, timestamp text, tool text, input text);
    create virtual table tool_call_text using fts5(call_key, tool, input, output, error);
    create virtual table session_text using fts5(session_id, label, topic, project, content, assistant);
  `);
  const steps = [
    { text: "let's do some work on blastline", at: "2026-09-24T06:23:40.077Z", endedAt: "2026-09-24T06:23:40.077Z", source: "user", tools: 0 },
    { text: "I'll load the design skill and locate the comment renderer.", at: "2026-09-24T06:23:45.000Z", endedAt: "2026-09-24T06:30:00.000Z", source: "thinking", tools: 3 },
    {
      text: "Three things in parallel now: confirm the follow-up commit state, produce run evidence for its PR.",
      at: "2026-09-24T16:23:42.000Z",
      endedAt: "2026-09-24T16:24:41.000Z",
      source: "narration",
      tools: 6,
      mix: { git: 1, test: 1, edit: 2, run: 2, read: 1 },
    },
    {
      text: "A bounded watcher is now polling PR 31 for the reviewer's verdict.",
      at: "2026-09-24T16:26:05.000Z",
      endedAt: "2026-09-24T16:29:12.000Z",
      source: "narration",
      tools: 4,
      mix: { run: 2, test: 1, other: 1 },
    },
  ];
  const ins = db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`);
  ins.run("7182303c-7ae6-4e9a-a0f3-fb7230b71749", "claude", "claude-fable-5-1", cwd, "2026-09-24T06:21:20.202Z", "2026-09-24T22:45:22.485Z", null, 31, "let's do some work on blastline", JSON.stringify([cwd, "/home/taylor"]));
  ins.run("00000000-bystander", "codex", "gpt-6-astra", "/home/taylor/elsewhere", "2026-09-24T16:00:00.000Z", "2026-09-24T17:00:00.000Z", "CGR-9", null, "unrelated", JSON.stringify(["/home/taylor/elsewhere"]));
  ins.run("00000000-earlier-here", "droid", null, cwd, "2026-09-23T10:00:00.000Z", "2026-09-23T11:00:00.000Z", null, null, "yesterday", null);
  db.prepare(`insert into session_timelines values (?,?)`).run("7182303c-7ae6-4e9a-a0f3-fb7230b71749", JSON.stringify({ version: 1, steps }));
  const calls = [
    ["c1", "2026-09-24T16:23:50.000Z", "Bash", JSON.stringify({ command: "NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts", description: "Run the figure tests" }), "5 passed"],
    ["c2", "2026-09-24T16:24:10.000Z", "Bash", JSON.stringify({ command: "git commit src/figure.ts -m 'fix(figure): no figure when nothing was mapped'" }), "[pr-figure e2a86cd] fix(figure): no figure when nothing was mapped"],
    ["c3", "2026-09-24T16:27:00.000Z", "Bash", JSON.stringify({ command: "NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run" }), "20 passed"],
    ["c4", "2026-09-24T16:28:00.000Z", "Read", JSON.stringify({ file_path: "src/figure.ts" }), "..."],
  ] as const;
  for (const [key, ts, tool, input, output] of calls) {
    db.prepare(`insert into tool_calls values (?,?,?,?,?)`).run(key, "7182303c-7ae6-4e9a-a0f3-fb7230b71749", ts, tool, input);
    db.prepare(`insert into tool_call_text values (?,?,?,?,?)`).run(key, tool, input, output, "");
  }
  db.close();
  return path;
}

function repoWithCommit(dir: string): { repo: string; sha: string } {
  const repo = join(dir, "repo");
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-24T16:23:46Z", GIT_COMMITTER_DATE: "2026-09-24T16:23:46Z", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  g("add", "a.ts");
  g("commit", "-q", "-m", "fix(figure): no figure when nothing was mapped");
  return { repo, sha: g("rev-parse", "HEAD") };
}

describe("SessionsIndex", () => {
  it("finds the sessions alive in a directory at a moment, most recent first, ignoring other directories and earlier days", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const idx = new SessionsIndex(fixtureDb(dir, "/work/blastline"));
    const at = idx.sessionsAt("/work/blastline", "2026-09-24T16:23:46.000Z");
    expect(at.map((s) => s.id)).toEqual(["7182303c-7ae6-4e9a-a0f3-fb7230b71749"]);
    expect(at[0]).toMatchObject({ agent: "claude", model: "claude-fable-5-1", prNumber: 31 });
    expect(idx.sessionsAt("/work/blastline", "2026-09-23T10:30:00.000Z").map((s) => s.agent)).toEqual(["droid"]);
    expect(idx.sessionsAt("/nowhere", "2026-09-24T16:23:46.000Z")).toEqual([]);
    idx.close();
  });

  it("picks the narration step whose window contains the time, and flags the nearest earlier one otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const idx = new SessionsIndex(fixtureDb(dir, "/work/blastline"));
    const sid = "7182303c-7ae6-4e9a-a0f3-fb7230b71749";
    const covering = idx.stepCovering(sid, "2026-09-24T16:23:46.000Z");
    expect(covering).toMatchObject({ covering: true, source: "narration", mix: { git: 1, test: 1, edit: 2, run: 2, read: 1 } });
    expect(covering?.text).toMatch(/^Three things in parallel now/);
    const between = idx.stepCovering(sid, "2026-09-24T16:25:30.000Z");
    expect(between).toMatchObject({ covering: false });
    expect(between?.text).toMatch(/^Three things/);
    expect(idx.stepCovering(sid, "2026-09-24T06:23:50.000Z")).toMatchObject({ covering: false, source: "user" });
    expect(idx.stepCovering("00000000-bystander", "2026-09-24T16:23:46.000Z")).toBeUndefined();
    idx.close();
  });

  it("joins a sha to the session whose indexed tool output mentions it, and lists only test-runner commands in a window", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const idx = new SessionsIndex(fixtureDb(dir, "/work/blastline"));
    expect(idx.sessionsMentioning("e2a86cd")).toEqual(["7182303c-7ae6-4e9a-a0f3-fb7230b71749"]);
    expect(idx.sessionsMentioning("deadbeef")).toEqual([]);
    expect(idx.testCommands("7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:23:42.000Z", "2026-09-24T16:24:41.000Z")).toEqual([
      "NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts",
    ]);
    expect(idx.testCommands("7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:00:00.000Z", "2026-09-24T17:00:00.000Z")).toHaveLength(2);
    idx.close();
  });
});

describe("fleetIntent", () => {
  it("binds a real commit to the session, the covering step and the tests run in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const { repo, sha } = repoWithCommit(dir);
    expect(commitTime(repo, sha)).toBe("2026-09-24T16:23:46.000Z");
    const idx = new SessionsIndex(fixtureDb(dir, repo));
    const intent = fleetIntent(idx, repo, sha);
    expect(intent).toBeDefined();
    expect(intent?.session.id).toBe("7182303c-7ae6-4e9a-a0f3-fb7230b71749");
    expect(intent?.step).toMatchObject({ covering: true });
    expect(intent?.testCommands).toEqual(["NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts"]);
    idx.close();
  });

  it("finds a session through the session-level text index and a worktree cwd when the call index has not reached it", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const { repo, sha } = repoWithCommit(dir);
    const path = fixtureDb(dir, "/somewhere/else");
    const db = new DatabaseSync(path);
    db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`).run("00000000-in-worktree", "codex", "gpt-6-astra", `${repo}/.agents/worktrees/feature`, "2026-09-24T16:00:00.000Z", "2026-09-24T23:00:00.000Z", "CGR-9", null, "in a worktree", null);
    db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`).run("00000000-from-home", "claude", "claude-fable-5-1", "/home/x", "2026-09-24T16:00:00.000Z", "2026-09-24T23:00:00.000Z", null, null, "from home", JSON.stringify(["/home/x"]));
    db.prepare(`insert into session_text values (?,?,?,?,?,?)`).run("00000000-from-home", "label", "", "", `commit ${sha.slice(0, 7)} landed`, "");
    db.close();
    const idx = new SessionsIndex(path);
    expect(idx.sessionsAt(repo, "2026-09-24T16:23:46.000Z").map((s) => s.id)).toEqual(["00000000-in-worktree"]);
    expect(fleetIntent(idx, repo, sha)?.session.id).toBe("00000000-from-home");
    idx.close();
  });

  it("prefers the session whose tool output mentions the sha when several were alive in the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const { repo, sha } = repoWithCommit(dir);
    const path = fixtureDb(dir, repo);
    const db = new DatabaseSync(path);
    db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`).run("00000000-newer-here", "codex", "gpt-6-astra", repo, "2026-09-24T16:00:00.000Z", "2026-09-24T23:00:00.000Z", null, null, "also here", null);
    db.prepare(`insert into tool_calls values (?,?,?,?,?)`).run("c9", "7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:24:20.000Z", "Bash", JSON.stringify({ command: "git log --oneline -1" }));
    db.prepare(`insert into tool_call_text values (?,?,?,?,?)`).run("c9", "Bash", "git log --oneline -1", `${sha.slice(0, 7)} fix(figure): no figure when nothing was mapped`, "");
    db.close();
    const idx = new SessionsIndex(path);
    expect(idx.sessionsAt(repo, "2026-09-24T16:23:46.000Z")[0]?.id).toBe("00000000-newer-here");
    expect(fleetIntent(idx, repo, sha)?.session.id).toBe("7182303c-7ae6-4e9a-a0f3-fb7230b71749");
    idx.close();
  });
});
