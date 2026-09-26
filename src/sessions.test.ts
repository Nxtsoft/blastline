import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SessionsIndex, commandsOf, commitTime, fleetIntent, localCheckpoint, repositoryRoot } from "./sessions.js";

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

  it("does not match a sibling directory that merely shares the prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const path = fixtureDb(dir, "/work/blastline-secondary");
    const db = new DatabaseSync(path);
    db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`).run("00000000-touched-sibling", "codex", null, "/home/x", "2026-09-24T16:00:00.000Z", "2026-09-24T17:00:00.000Z", null, null, "", JSON.stringify(["/work/blastline-secondary/src"]));
    db.close();
    const idx = new SessionsIndex(path);
    expect(idx.sessionsAt("/work/blastline", "2026-09-24T16:23:46.000Z")).toEqual([]);
    expect(idx.sessionsAt("/work/blastline-secondary", "2026-09-24T16:23:46.000Z").map((s) => s.id)).toEqual(["7182303c-7ae6-4e9a-a0f3-fb7230b71749", "00000000-touched-sibling"]);
    // a session that only touched a directory under the repository counts for the repository
    expect(idx.sessionsAt("/work/blastline-secondary/src", "2026-09-24T16:23:46.000Z").map((s) => s.id)).toEqual(["00000000-touched-sibling"]);
    idx.close();
  });

  it("matches a touched child directory of a path that JSON escapes, and names a missing index", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const path = fixtureDb(dir, "/elsewhere");
    const db = new DatabaseSync(path);
    db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`).run("00000000-quoted", "claude", null, "/home/x", "2026-09-24T16:00:00.000Z", "2026-09-24T17:00:00.000Z", null, null, "", JSON.stringify(['/work/we"ird\\path/src']));
    db.close();
    const idx = new SessionsIndex(path);
    expect(idx.sessionsAt('/work/we"ird\\path', "2026-09-24T16:23:46.000Z").map((s) => s.id)).toEqual(["00000000-quoted"]);
    idx.close();
    expect(() => new SessionsIndex(join(dir, "missing.db"))).toThrow(/no fleet session index at .*missing\.db/);
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

describe("sessionsMentioning on a damaged index", () => {
  it("answers from the session text index when the per-call FTS table is missing or broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const path = fixtureDb(dir, "/work/blastline");
    const db = new DatabaseSync(path);
    db.exec("drop table tool_call_text");
    db.prepare(`insert into session_text values (?,?,?,?,?,?)`).run("7182303c-7ae6-4e9a-a0f3-fb7230b71749", "label", "", "", "commit e2a86cd landed", "");
    db.close();
    const idx = new SessionsIndex(path);
    expect(idx.sessionsMentioning("e2a86cd")).toEqual(["7182303c-7ae6-4e9a-a0f3-fb7230b71749"]);
    expect(idx.sessionsMentioning("nothing-here")).toEqual([]);
    idx.close();
  });
});

describe("localCheckpoint", () => {
  it("shapes the fleet intent like a checkpoint ref would read, with the commit's files and no id", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const { repo, sha } = repoWithCommit(dir);
    const idx = new SessionsIndex(fixtureDb(dir, repo));
    expect(localCheckpoint(idx, repo, sha, ["a.ts"])).toEqual({
      id: "",
      commit: sha,
      agent: "claude",
      model: "claude-fable-5-1",
      prompt: "let's do some work on blastline",
      narration: { started: "Three things in parallel now: confirm the follow-up commit state, produce run evidence for its PR.", ended: "", texts: 1, tools: 0 },
      sessions: [{ id: "7182303c-7ae6-4e9a-a0f3-fb7230b71749", lines: 0, hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
      filesTouched: ["a.ts"],
      testCommands: ["NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts"],
      source: "sessions.db",
      reasons: [],
    });
    idx.close();
  });

  it("reads the session's edits for the symbols asked about, by line range as committed or by name, with the covering narration as the reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const { repo, sha } = repoWithCommit(dir);
    const path = fixtureDb(dir, repo);
    const db = new DatabaseSync(path);
    db.prepare(`insert into tool_calls values (?,?,?,?,?)`).run("e1", "7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:23:55.000Z", "Edit", JSON.stringify({ file_path: `${repo}/a.ts`, old_string: "export const a = 0;", new_string: "export const a = 1;" }));
    db.prepare(`insert into tool_calls values (?,?,?,?,?)`).run("e2", "7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:24:20.000Z", "Edit", JSON.stringify({ file_path: `${repo}/b.ts`, old_string: "", new_string: "export const zed = 2;" }));
    db.close();
    const idx = new SessionsIndex(path);
    const symbols = [
      { path: "a.ts", label: "a", from: 1, to: 1 },
      { path: "a.ts", label: "nothere", from: 9, to: 9 },
      { path: "b.ts", label: "zed" },
    ];
    expect(localCheckpoint(idx, repo, sha, ["a.ts"], symbols)?.reasons).toEqual([
      { path: "a.ts", label: "a", turn: 1, why: "Three things in parallel now: confirm the follow-up commit state, produce run evidence for its PR." },
      { path: "b.ts", label: "zed", turn: 2, why: "Three things in parallel now: confirm the follow-up commit state, produce run evidence for its PR." },
    ]);
    expect(idx.edits("7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:23:42.000Z", "2026-09-24T16:24:41.000Z").map((e) => e.path)).toEqual([`${repo}/a.ts`, `${repo}/b.ts`]);
    idx.close();
  });
});

describe("commandsOf", () => {
  it("reads Claude Bash, Droid Execute and Codex exec envelopes as the index stores them", () => {
    expect(commandsOf(JSON.stringify({ command: "NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run", description: "Run tests" }))).toEqual(["NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run"]);
    expect(commandsOf("gh pr diff 247 --repo Turing-Labs-AI/turing-agents")).toEqual(["gh pr diff 247 --repo Turing-Labs-AI/turing-agents"]);
    // real Codex shape: a JS program; every exec_command({cmd: <literal>}) is one command
    const codex = JSON.stringify({ input: 'text(await tools.exec_command({cmd:"cargo test -p blastline -- --nocapture",timeout_ms:120000}))\n' });
    expect(commandsOf(codex)).toEqual(["cargo test -p blastline -- --nocapture"]);
    const escaped = JSON.stringify({ input: "text(await tools.exec_command({cmd:\"python3 - <<'PY'\\nprint(\\\"hi\\\")\\nPY\"}))" });
    expect(commandsOf(escaped)).toEqual(["python3 - <<'PY'\nprint(\"hi\")\nPY"]);
    const many = JSON.stringify({ input: "const a = await tools.exec_command({cmd:`bunx vitest run ${file}`}); const b = await tools.exec_command({ cmd: 'git status' , yield_time_ms: 5 });" });
    expect(commandsOf(many)).toEqual(["bunx vitest run ${file}", "git status"]);
    expect(commandsOf(JSON.stringify({ input: "text(await tools.read_file({path:'a'}))" }))).toEqual([]);
  });

  it("counts a Codex test run as a test command", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const path = fixtureDb(dir, "/work/blastline");
    const db = new DatabaseSync(path);
    db.prepare(`insert into tool_calls values (?,?,?,?,?)`).run("x1", "7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:24:00.000Z", "exec", JSON.stringify({ input: 'text(await tools.exec_command({cmd:"go test ./..."}))\n' }));
    db.close();
    const idx = new SessionsIndex(path);
    expect(idx.testCommands("7182303c-7ae6-4e9a-a0f3-fb7230b71749", "2026-09-24T16:23:42.000Z", "2026-09-24T16:24:41.000Z")).toEqual([
      "NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts",
      "go test ./...",
    ]);
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

  it("counts a session in a sibling linked worktree of the same repository, at the commit's author time", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-sessions-"));
    const { repo, sha } = repoWithCommit(dir);
    const wt = join(repo, ".agents", "worktrees", "feature");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feature", wt, "HEAD"]);
    expect(repositoryRoot(wt)).toBe(repo);
    // a rebase-merge style commit: author time kept, committer time hours later
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "rebased"], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-24T16:23:46Z", GIT_COMMITTER_DATE: "2026-09-24T23:30:00Z", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    const rebased = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(commitTime(wt, rebased)).toBe("2026-09-24T16:23:46.000Z");
    const path = fixtureDb(dir, join(repo, ".agents", "worktrees", "other"));
    const idx = new SessionsIndex(path);
    expect(fleetIntent(idx, wt, rebased)?.session.id).toBe("7182303c-7ae6-4e9a-a0f3-fb7230b71749");
    expect(fleetIntent(idx, repo, sha)?.session.id).toBe("7182303c-7ae6-4e9a-a0f3-fb7230b71749");
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
