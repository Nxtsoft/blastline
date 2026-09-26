import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECKPOINT_BRANCH, agentForAddress, checkpointFor, checkpointPlace, checkpointPlaces, checkpointPushHint, checkpointRef, checkpointTrailer, editNames, narrationIn, promptLine, provenanceOf, symbolReasonsIn, testCommandsIn, transcriptHash, typedByPerson, windowsOf, writtenWithin } from "./checkpoint.js";

// src/testdata/checkpoint-ref/ is the tree of a real Entire 0.11.2 checkpoint
// (ref refs/entire/checkpoints/H5/01M3AY9296319GSPWRKXGHXMH5, written for
// commit 14074f7 of the research probe on 2026-09-24), minus 0/full.jsonl, the
// raw transcript. The test rebuilds that ref inside a throwaway repository so
// `git show <ref>:<path>` is exercised for real, and adds a fake 0/full.jsonl
// whose content must never surface.
const FIXTURE = fileURLToPath(new URL("./testdata/checkpoint-ref/", import.meta.url));
const ID = "01M3AY9296319GSPWRKXGHXMH5";
const RAW_SENTINEL = "RAW-TRANSCRIPT-MUST-NOT-LEAK session-path=/home/x/.agents/hooks";

// A second checkpoint, in the same layout, from a writer that ran a test and
// stamped `source` (the agents-cli writer does; Entire's hooks do not).
const ID_TESTED = "01M3AY9296319GSPWRKXGHXMJ7";
// Record shape from the probe's 0/transcript.jsonl (an assistant turn with one Bash tool_use):
// {"v":1,"agent":"claude-code","cli_version":"0.11.2","type":"assistant","ts":"2026-09-25T00:08:39.088Z",
//  "id":"msg_011CfPBgqQYDd2B16caqa8Zv","input_tokens":2,"output_tokens":86,
//  "content":[{"id":"toolu_01Xbr51BuPQgbBm3dUw9CyZY","input":{"command":"git commit src/comment.ts -m '...' && git rev-parse HEAD"},
//              "name":"Bash","result":{"output":"[entire-probe 14074f7] ...","status":"success"},"type":"tool_use"}]}
const VITEST_RECORD = JSON.stringify({
  v: 1,
  agent: "claude-code",
  cli_version: "0.11.2",
  type: "assistant",
  ts: "2026-09-25T00:08:40.000Z",
  id: "msg_test",
  input_tokens: 2,
  output_tokens: 30,
  content: [
    {
      id: "toolu_test",
      input: { command: "bunx vitest run src/comment.test.ts" },
      name: "Bash",
      result: { output: "Test Files  1 passed (1)\nSECRET-TOOL-OUTPUT", status: "success" },
      type: "tool_use",
    },
  ],
});

// An assistant turn that explains itself and then edits src/comment.ts.
const EDIT_RECORDS = [
  JSON.stringify({ v: 1, type: "assistant", ts: "2026-09-25T00:09:00.000Z", id: "msg_a", content: [{ type: "text", text: "The marker comment should say what the Action does with it.\nSecond line, never shown." }] }),
  JSON.stringify({ v: 1, type: "user", ts: "2026-09-25T00:09:01.000Z", content: [{ type: "text", text: "ok" }] }),
  JSON.stringify({
    v: 1,
    type: "assistant",
    ts: "2026-09-25T00:09:02.000Z",
    id: "msg_b",
    content: [
      { id: "toolu_edit", type: "tool_use", name: "Edit", input: { file_path: "/home/x/blastline/src/comment.ts", old_string: "/** old */\nexport const COMMENT_MARKER = 1;", new_string: "/** First line of every comment. */\nexport const COMMENT_MARKER = 2;" }, result: { output: "SECRET-EDIT-RESULT", status: "success" } },
    ],
  }),
].join("\n");
const ID_EDITED = "01M3AY9296319GSPWRKXGHXMN3";

let repo: string;
let commitEdited: string;
let commitWithRef: string;
let commitTested: string;
let commitNoTrailer: string;
let commitDanglingTrailer: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@blastline.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function blob(content: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
}

/** Write an Entire-layout checkpoint ref from a flat path -> content map. */
function writeCheckpointRef(id: string, files: Record<string, string>): void {
  const inner = Object.entries(files)
    .filter(([p]) => p.startsWith("0/"))
    .map(([p, c]) => `100644 blob ${blob(c)}\t${p.slice(2)}`)
    .join("\n");
  const innerTree = execFileSync("git", ["-C", repo, "mktree"], { input: inner + "\n", encoding: "utf8" }).trim();
  const root = [
    ...Object.entries(files)
      .filter(([p]) => !p.startsWith("0/"))
      .map(([p, c]) => `100644 blob ${blob(c)}\t${p}`),
    `040000 tree ${innerTree}\t0`,
  ].join("\n");
  const rootTree = execFileSync("git", ["-C", repo, "mktree"], { input: root + "\n", encoding: "utf8" }).trim();
  const commit = git("commit-tree", rootTree, "-m", `Finalize transcript for Checkpoint: ${id}`);
  git("update-ref", checkpointRef(id), commit);
}

function commitFile(path: string, content: string, message: string): string {
  writeFileSync(join(repo, path), content);
  git("add", path);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "blastline-checkpoint-"));
  git("init", "-q");
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  const fixture = (p: string): string => readFileSync(join(FIXTURE, p), "utf8");
  const files = {
    "metadata.json": fixture("metadata.json"),
    "0/metadata.json": fixture("0/metadata.json"),
    "0/prompt.txt": fixture("0/prompt.txt"),
    "0/transcript.jsonl": fixture("0/transcript.jsonl"),
    "0/content_hash.txt": fixture("0/content_hash.txt"),
    "0/full.jsonl": RAW_SENTINEL,
  };
  writeCheckpointRef(ID, files);
  writeCheckpointRef(ID_TESTED, {
    ...files,
    "metadata.json": JSON.stringify({ ...(JSON.parse(files["metadata.json"]) as object), source: "agents-cli" }),
    "0/transcript.jsonl": files["0/transcript.jsonl"].trimEnd() + "\n" + VITEST_RECORD + "\n",
  });

  writeCheckpointRef(ID_EDITED, { ...files, "0/transcript.jsonl": files["0/transcript.jsonl"].trimEnd() + "\n" + EDIT_RECORDS + "\n" });

  commitNoTrailer = commitFile("src/comment.ts", "export const COMMENT_MARKER = 1;\n", "feat: base");
  commitEdited = commitFile("src/comment.ts", "export const COMMENT_MARKER = 3;\n", `docs(comment): marker\n\nEntire-Checkpoint: ${ID_EDITED}\n`);
  commitWithRef = commitFile("src/comment.ts", "export const COMMENT_MARKER = 2;\n", `docs(comment): clarify the marker comment\n\nEntire-Checkpoint: ${ID}\n`);
  commitTested = commitFile("src/comment.ts", "export const COMMENT_MARKER = 3;\n", `test: run it\n\nEntire-Checkpoint: ${ID_TESTED}\n`);
  commitDanglingTrailer = commitFile("src/comment.ts", "export const COMMENT_MARKER = 4;\n", "chore: unpushed ref\n\nEntire-Checkpoint: 01M3AY9296319GSPWRKXGHXZZZ\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("promptLine", () => {
  it("skips the agents-cli worktree preamble and returns the first line the human wrote, capped at 200", () => {
    const preamble = "You are in a git worktree of Nxtsoft/blastline on branch pr-brief (base main). Do exactly these steps.\n\n";
    expect(promptLine(preamble + "Ship the PR brief.\nThen open the PR.")).toBe("Ship the PR brief.");
    // the preamble is one line; without a blank line after it the next line still wins
    expect(promptLine("You are in a git worktree of X on branch y.\nShip the PR brief.")).toBe("Ship the PR brief.");
    expect(promptLine("Plain prompt first line\nsecond")).toBe("Plain prompt first line");
    expect(promptLine("\n\n  indented after blanks\n")).toBe("indented after blanks");
    expect(promptLine(preamble)).toBe("");
    expect(promptLine("x".repeat(300))).toHaveLength(200);
  });
});

describe("promptLine on a turn with several prompts", () => {
  it("skips a prompt the harness delivered (a tag) and the --- separators, and returns the first line a person typed", () => {
    const prompt = [
      "<task-notification>",
      "<task-id>bocrjw2de</task-id>",
      "<summary>Background command completed</summary>",
      "</task-notification>",
      "",
      "---",
      "",
      "<system-reminder>keep going</system-reminder>",
      "",
      "---",
      "",
      "You are in a git worktree of turing-webapp on branch x",
      "revert the autofix and keep the router-driven page key",
      "second line",
    ].join("\n");
    expect(promptLine(prompt)).toBe("revert the autofix and keep the router-driven page key");
    expect(promptLine("<task-notification>\n<summary>x</summary>\n</task-notification>\n")).toBe("");
  });

  it("skips a skill's instructions, which Claude Code injects as a prompt, the same way the transcript walk does", () => {
    // Real shape from checkpoint 89624f0f372c on turing-webapp (path shortened).
    const skill = "Base directory for this skill: /Users/x/.claude/plugins/cache/superset/skills/page\n\n# Page\n\nWrite a page.";
    expect(typedByPerson(skill)).toBe(false);
    expect(promptLine(skill)).toBe("");
    expect(promptLine(`${skill}\n\n---\n\npublish the closure sweep as a page`)).toBe("publish the closure sweep as a page");
    expect(typedByPerson("  ")).toBe(false);
    expect(typedByPerson("fix the cap")).toBe(true);
  });
});

// Entire 0.10.0 branch backend: 12-hex ids, one shared branch, <first two>/<rest>/ directories.
const HEX_A = "c892ec03a62e";
const HEX_B = "782a9bbcae1b";
const HEX_C = "dd54cfcde765";
const SESSION = "0d2e1746-ad6a-45c2-a9c8-371131273a49";
const stamp = (n: number): string => `2026-09-26T02:${String(n).padStart(2, "0")}:00.000Z`;
const rec = (type: string, ts: string, content: object[], extra: object = {}): string => JSON.stringify({ v: 1, agent: "claude-code", cli_version: "0.10.0", type, ts, content, ...extra });
const text = (t: string): object => ({ type: "text", text: t });
const user = (t: string): object => ({ id: "u", text: t });
const edit = (path: string, s: string): object => ({ id: "e", type: "tool_use", name: "Edit", input: { file_path: `/Users/x/wt/${path}`, old_string: "a", new_string: s }, result: { output: "SECRET", status: "success" } });
const bash = (cmd: string): object => ({ id: "b", type: "tool_use", name: "Bash", input: { command: cmd }, result: { output: "SECRET", status: "success" } });
// One cumulative session transcript, as the branch backend snapshots it: an unrelated turn, then the turn that made commit A, then the turn that made commit C.
const CUMULATIVE = [
  rec("user", stamp(1), [user("can you look at the list of tickets")]),
  rec("assistant", stamp(2), [text("Here are the five tickets.")]),
  rec("assistant", stamp(3), [bash("bunx vitest run src/tickets.test.ts")]),
  rec("user", stamp(5), [user("<task-notification>done</task-notification>")]),
  rec("user", stamp(6), [user("now give the round-size cap one home")]),
  rec("assistant", stamp(7), [text("I'll start by reading the ticket, then set up a worktree off dev.\nSecond line.")]),
  rec("user", stamp(8), [user("<task-notification>ci green</task-notification>")]),
  rec("assistant", stamp(9), [edit("src/round-size.ts", "export const ROUND_SIZE_MAX = 8;")]),
  rec("assistant", stamp(10), [bash("bunx vitest run src/round-size.test.ts")]),
  rec("assistant", stamp(11), [text("The path in my notes had a hyphen where the real path has a slash.")]),
];
const CUMULATIVE_C = [
  ...CUMULATIVE,
  rec("assistant", stamp(30), [text("All checks pass on the tip, but CodeRabbit pushed one more autofix. Reviewing it before merging.")]),
  rec("assistant", stamp(31), [bash("git revert --no-edit HEAD")]),
];
const HASH_A = transcriptHash(CUMULATIVE);
const HASH_C = transcriptHash(CUMULATIVE_C);
const NOTIFICATION_PROMPT = "<task-notification>\n<summary>CI checks landing</summary>\n</task-notification>\n\n---\n\n<task-notification>\n<summary>again</summary>\n</task-notification>\n";

/** Write a branch-backend checkpoint into the tree of origin's entire/checkpoints/v1, keeping what is already there. */
function writeBranchCheckpoint(id: string, files: Record<string, string>): void {
  const ref = `refs/remotes/origin/${CHECKPOINT_BRANCH}`;
  const existing = (() => {
    try {
      return git("ls-tree", "-r", ref)
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t") as [string, string]);
    } catch {
      return [];
    }
  })();
  const entries = new Map<string, string>(existing.map(([mode, path]) => [path, mode]));
  for (const [p, c] of Object.entries(files)) entries.set(`${id.slice(0, 2)}/${id.slice(2)}/${p}`, `100644 blob ${blob(c)}`);
  const treeOf = (paths: [string, string][]): string => {
    const dirs = new Map<string, [string, string][]>();
    const leaves: string[] = [];
    for (const [path, mode] of paths) {
      const slash = path.indexOf("/");
      if (slash === -1) leaves.push(`${mode}\t${path}`);
      else {
        const dir = path.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir)!.push([path.slice(slash + 1), mode]);
      }
    }
    for (const [dir, inner] of dirs) leaves.push(`040000 tree ${treeOf(inner)}\t${dir}`);
    return execFileSync("git", ["-C", repo, "mktree"], { input: leaves.join("\n") + "\n", encoding: "utf8" }).trim();
  };
  const tree = treeOf([...entries.entries()]);
  git("update-ref", ref, git("commit-tree", tree, "-m", `Checkpoint: ${id}`));
}

function branchFiles(id: string, createdAt: string, transcript: string[], prompt: string, second?: { session: string; transcript: string[] }): Record<string, string> {
  const dir = `/${id.slice(0, 2)}/${id.slice(2)}`;
  const meta = (i: number, session: string): string =>
    JSON.stringify({ cli_version: "0.10.0", checkpoint_id: id, session_id: session, created_at: createdAt, agent: "Claude Code", model: "claude-fable-5-1", turn_id: "268aecc82583", compact_transcript_start: 0, files_touched: [] });
  const sessions = [{ metadata: `${dir}/0/metadata.json`, transcript: `${dir}/0/full.jsonl` }];
  if (second) sessions.push({ metadata: `${dir}/1/metadata.json`, transcript: `${dir}/1/full.jsonl` });
  return {
    "metadata.json": JSON.stringify({ cli_version: "0.10.0", checkpoint_id: id, strategy: "manual-commit", branch: "turing-126", checkpoints_count: 3, files_touched: null, sessions }),
    "0/metadata.json": meta(0, SESSION),
    "0/prompt.txt": prompt,
    "0/transcript.jsonl": transcript.join("\n") + "\n",
    "0/content_hash.txt": "x",
    "0/full.jsonl": RAW_SENTINEL,
    ...(second && { "1/metadata.json": meta(1, second.session), "1/prompt.txt": "", "1/transcript.jsonl": second.transcript.join("\n") + "\n", "1/full.jsonl": RAW_SENTINEL }),
  };
}

describe("checkpointFor on the branch backend", () => {
  let commitA: string;
  let commitB: string;
  let commitC: string;
  let commitMissing: string;
  let commitTwoSessions: string;
  const HEX_D = "89624f0f372c";
  const OTHER = "1dd6ba8f-0000-4000-8000-000000000000";
  beforeAll(() => {
    // Real Entire 0.10.0 shape: created_at precedes the snapshot's last records, so time is no boundary; line counts are.
    writeBranchCheckpoint(HEX_A, branchFiles(HEX_A, stamp(9), CUMULATIVE, NOTIFICATION_PROMPT + "\n---\n\nnow give the round-size cap one home\n"));
    writeBranchCheckpoint(HEX_B, branchFiles(HEX_B, stamp(10), CUMULATIVE, NOTIFICATION_PROMPT));
    writeBranchCheckpoint(HEX_C, branchFiles(HEX_C, stamp(30), CUMULATIVE_C, NOTIFICATION_PROMPT));
    writeBranchCheckpoint(HEX_D, branchFiles(HEX_D, stamp(31), CUMULATIVE_C, NOTIFICATION_PROMPT, { session: OTHER, transcript: [rec("user", stamp(20), [user("in the other session")]), rec("assistant", stamp(21), [text("Other session at work."), bash("bunx vitest run src/other.test.ts")])] }));
    commitA = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 8;\n", `refactor(round-size): one home\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEntire-Checkpoint: ${HEX_A}\n`);
    commitB = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 8;\nexport const ROUND_SIZE_MIN = 1;\n", `feat(luna): page key\n\nEntire-Checkpoint: ${HEX_B}\n`);
    commitC = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 8;\n", `revert(luna): keep the router-driven page key\n\nEntire-Checkpoint: ${HEX_C}\n`);
    commitMissing = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 9;\n", "fix: gate\n\nEntire-Checkpoint: 0123456789ab\n");
    commitTwoSessions = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 10;\n", `fix: two sessions\n\nEntire-Checkpoint: ${HEX_D}\n`);
  });

  it("accepts a 12-hex trailer and names the shared branch as its place, local branch first", () => {
    expect(checkpointTrailer(repo, commitA)).toBe(HEX_A);
    expect(checkpointPlaces(HEX_A)).toEqual([
      { ref: "refs/heads/entire/checkpoints/v1", prefix: "c8/92ec03a62e/" },
      { ref: "refs/remotes/origin/entire/checkpoints/v1", prefix: "c8/92ec03a62e/" },
    ]);
    expect(checkpointPlaces(ID)).toEqual([{ ref: checkpointRef(ID), prefix: "" }]);
    expect(checkpointPlace(repo, HEX_A)).toEqual({ ref: "refs/remotes/origin/entire/checkpoints/v1", prefix: "c8/92ec03a62e/" });
    expect(checkpointPlace(repo, "0123456789ab")).toBeUndefined();
    expect(checkpointPushHint(HEX_A)).toBe("push the branch entire/checkpoints/v1");
    expect(checkpointPushHint(ID)).toBe("push refs/entire/checkpoints/*");
  });

  it("reads the checkpoint from the branch: the turn that first edited the commit's files gives the narration and the tests, not the session's earlier turns", () => {
    const cp = checkpointFor(repo, commitA, [], new Map(), ["src/round-size.ts"]);
    expect(cp).toMatchObject({
      id: HEX_A,
      agent: "Claude Code",
      model: "claude-fable-5-1",
      prompt: "now give the round-size cap one home",
      narration: { started: "I'll start by reading the ticket, then set up a worktree off dev.", ended: "The path in my notes had a hyphen where the real path has a slash.", texts: 2, tools: 2 },
      sessions: [{ id: SESSION, lines: 10, hash: HASH_A }],
      testCommands: ["bunx vitest run src/round-size.test.ts"],
      source: "entire",
    });
    expect(cp?.sameStepAs).toBeUndefined();
    expect(JSON.stringify(cp)).not.toContain("SECRET");
    expect(JSON.stringify(cp)).not.toContain("RAW-TRANSCRIPT");
  });

  it("reads the whole transcript when the commit's files were never edited by a tool and no previous checkpoint bounds it", () => {
    const cp = checkpointFor(repo, commitA, [], new Map(), ["src/other.ts"]);
    expect(cp?.narration.started).toBe("Here are the five tickets.");
    expect(cp?.testCommands).toEqual(["bunx vitest run src/tickets.test.ts", "bunx vitest run src/round-size.test.ts"]);
  });

  it("reads only the lines after the previous checkpoint of the same session, and says so when that leaves nothing", () => {
    const read = new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]);
    const b = checkpointFor(repo, commitB, [], read, ["src/round-size.ts"]);
    expect(b?.narration).toEqual({ started: "", ended: "", texts: 0, tools: 0 });
    expect(b?.sameStepAs).toBe(commitA);
    expect(b?.testCommands).toEqual([]);
    expect(b?.sessions).toEqual([{ id: SESSION, lines: 10, hash: HASH_A }]);
    // The last record of A's snapshot is stamped after A's created_at; a time boundary would hand it to C as well.
    const c = checkpointFor(repo, commitC, [], new Map([[SESSION, { sha: commitB, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(c?.narration).toEqual({ started: "All checks pass on the tip, but CodeRabbit pushed one more autofix. Reviewing it before merging.", ended: "", texts: 1, tools: 1 });
    expect(c?.sameStepAs).toBeUndefined();
    expect(c?.prompt).toBe("");
    expect(c?.sessions).toEqual([{ id: SESSION, lines: 12, hash: HASH_C }]);
  });

  it("still extends a snapshot whose last tool call gained its result since, as Entire fills results in later", () => {
    // Real shape: 0ec8874549e6's last record is the commit's Bash call without `result`; 5cc9e7709e27 carries the same record with it.
    const withoutResult = [...CUMULATIVE.slice(0, 8), rec("assistant", stamp(10), [{ id: "b", type: "tool_use", name: "Bash", input: { command: "bunx vitest run src/round-size.test.ts" } }]), CUMULATIVE[9]!];
    expect(transcriptHash(withoutResult)).toBe(transcriptHash(CUMULATIVE));
    const w = windowsOf(CUMULATIVE_C.join("\n"), { sha: "a", lines: 10, hash: transcriptHash(withoutResult) }, ["src/round-size.ts"]);
    expect(w.extended).toBe(true);
    expect(w.sinceWindow.split("\n")).toHaveLength(2);
  });

  it("reads a transcript whole when it does not extend what the previous checkpoint read, whatever the counts say", () => {
    // A writer that stores one transcript per commit (blastline checkpoint write): the same session id, a different, shorter transcript.
    const c = checkpointFor(repo, commitC, [], new Map([[SESSION, { sha: commitB, lines: 10, hash: transcriptHash(["{}"]) }]]), ["src/round-size.ts"]);
    expect(c?.narration.started).toBe("I'll start by reading the ticket, then set up a worktree off dev.");
    expect(c?.testCommands).toEqual(["bunx vitest run src/round-size.test.ts"]);
    expect(c?.sameStepAs).toBeUndefined();
  });

  it("ignores what was read of another session", () => {
    const b = checkpointFor(repo, commitB, [], new Map([["other", { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(b?.narration.started).toBe("I'll start by reading the ticket, then set up a worktree off dev.");
    expect(b?.sameStepAs).toBeUndefined();
  });

  it("bounds each session of a two-session checkpoint by its own snapshot, and is the same step only when every session's part is empty", () => {
    const d = checkpointFor(repo, commitTwoSessions, [], new Map([[SESSION, { sha: commitC, lines: 12, hash: HASH_C }]]), ["src/round-size.ts"]);
    const other = [rec("user", stamp(20), [user("in the other session")]), rec("assistant", stamp(21), [text("Other session at work."), bash("bunx vitest run src/other.test.ts")])];
    expect(d?.sessions).toEqual([
      { id: SESSION, lines: 12, hash: HASH_C },
      { id: OTHER, lines: 2, hash: transcriptHash(other) },
    ]);
    expect(d?.narration).toEqual({ started: "Other session at work.", ended: "", texts: 1, tools: 1 });
    expect(d?.testCommands).toEqual(["bunx vitest run src/other.test.ts"]);
    expect(d?.sameStepAs).toBeUndefined();
    const again = checkpointFor(repo, commitTwoSessions, [], new Map([[SESSION, { sha: commitC, lines: 12, hash: HASH_C }], [OTHER, { sha: commitC, lines: 2, hash: transcriptHash(other) }]]), ["src/round-size.ts"]);
    expect(again?.sameStepAs).toBe(commitC);
  });

  it("finds a symbol's reason in the since-window even when the narration window starts later", () => {
    const cp = checkpointFor(repo, commitA, [{ path: "src/round-size.ts", label: "ROUND_SIZE_MAX" }], new Map(), ["src/round-size.ts"]);
    expect(cp?.reasons).toEqual([{ path: "src/round-size.ts", label: "ROUND_SIZE_MAX", turn: 4, why: "I'll start by reading the ticket, then set up a worktree off dev." }]);
  });

  it("reports the id but no checkpoint when the branch does not hold it", () => {
    expect(checkpointTrailer(repo, commitMissing)).toBe("0123456789ab");
    expect(checkpointFor(repo, commitMissing)).toBeUndefined();
  });
});

describe("windowsOf and narrationIn", () => {
  it("keeps an unstamped transcript whole and counts texts and tool calls", () => {
    const t = [JSON.stringify({ type: "assistant", content: [text("a"), bash("ls")] }), "not json", JSON.stringify({ type: "assistant", content: [text("b")] })].join("\n");
    const lines = t.split("\n");
    expect(windowsOf(t, undefined, ["x.ts"])).toEqual({ sinceWindow: t, stepWindow: t, lines: 3, hash: transcriptHash(lines), extended: false });
    expect(windowsOf(t, { sha: "a", lines: 2, hash: transcriptHash(lines.slice(0, 2)) }, ["x.ts"])).toMatchObject({ sinceWindow: lines[2], extended: true });
    expect(windowsOf(t, { sha: "a", lines: 2, hash: "not the prefix" }, ["x.ts"])).toMatchObject({ sinceWindow: t, extended: false });
    expect(windowsOf(t, { sha: "a", lines: 9, hash: transcriptHash(lines) }, ["x.ts"])).toMatchObject({ sinceWindow: t, extended: false });
    expect(narrationIn(t)).toEqual({ started: "a", ended: "b", texts: 2, tools: 1 });
  });

  it("starts the step at the prompt before a Bash command that names the file, when no edit tool touched it", () => {
    const t = [
      rec("user", stamp(1), [user("first ask")]),
      rec("assistant", stamp(2), [text("on it"), bash("cat -n src/index.ts")]),
      rec("user", stamp(3), [user("now the cap")]),
      rec("assistant", stamp(4), [text("editing with a script")]),
      rec("user", stamp(5), [user("Base directory for this skill: /x/.claude/skills/git-worktree")]),
      rec("assistant", stamp(6), [bash("python3 - <<'EOF'\nedit('app/lib/use-round-size.ts', [])\nEOF")]),
    ].join("\n");
    const w = windowsOf(t, undefined, ["app/(protected)/lib/use-round-size.ts"]);
    expect(w.stepWindow.split("\n")).toHaveLength(4);
    expect(narrationIn(w.stepWindow).started).toBe("editing with a script");
  });

  it("does not walk back past a harness notification into an earlier human turn", () => {
    const t = [rec("user", stamp(1), [user("first ask")]), rec("assistant", stamp(2), [text("on it")]), rec("user", stamp(3), [user("<task-notification>x</task-notification>")]), rec("assistant", stamp(4), [edit("a.ts", "x")])].join("\n");
    expect(windowsOf(t, undefined, ["a.ts"]).stepWindow.split("\n")).toHaveLength(4);
  });
});

describe("checkpointRef", () => {
  it("shards by the last two characters of the id, as Entire does", () => {
    expect(checkpointRef(ID)).toBe("refs/entire/checkpoints/H5/01M3AY9296319GSPWRKXGHXMH5");
  });
});

describe("checkpointFor", () => {
  it("resolves the trailer to the allowlisted subset of the real checkpoint", () => {
    expect(checkpointFor(repo, commitWithRef)).toEqual({
      id: ID,
      commit: commitWithRef,
      agent: "Claude Code",
      model: "claude-sonnet-5",
      prompt:
        "In this repo (cwd), edit src/comment.ts: change the doc comment line directly above the exported COMMENT_MARKER constant to read exactly: /** First line of every comment: the Action finds the existing",
      narration: { started: "Commit sha: `14074f79e3aa14b9bf7d5d476ec119aeb2bae6e3`", ended: "", texts: 1, tools: 3 },
      sessions: [{ id: "3c0c80c7-265b-42aa-9f37-58a615449010", lines: 5, hash: transcriptHash(readFileSync(join(FIXTURE, "0/transcript.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "")) }],
      filesTouched: ["src/comment.ts"],
      testCommands: [],
      source: "entire",
      reasons: [],
    });
  });

  it("caps the prompt at 200 characters", () => {
    expect(checkpointFor(repo, commitWithRef)?.prompt.length).toBe(200);
  });

  it("lists the test runner commands the session ran and keeps a writer's source", () => {
    const cp = checkpointFor(repo, commitTested);
    expect(cp?.testCommands).toEqual(["bunx vitest run src/comment.test.ts"]);
    expect(cp?.source).toBe("agents-cli");
  });

  it("never surfaces the raw transcript or any tool output", () => {
    const text = JSON.stringify(checkpointFor(repo, commitTested));
    expect(text).not.toContain("RAW-TRANSCRIPT");
    expect(text).not.toContain("SECRET-TOOL-OUTPUT");
    // The probe transcript's grep output quotes src/comment.ts source; the brief must not.
    expect(text).not.toContain("import type { ChangedFileImpact");
  });

  it("returns undefined for a commit without a trailer", () => {
    expect(checkpointFor(repo, commitNoTrailer)).toBeUndefined();
    expect(checkpointTrailer(repo, commitNoTrailer)).toBeUndefined();
  });

  it("reads Entire's layout by position and never follows the paths metadata.json declares", () => {
    // A checkpoint whose metadata points the compact transcript at the raw
    // transcript: the reader must still open <i>/transcript.jsonl.
    const id = "01M3AY9296319GSPWRKXGHXMK9";
    const meta = JSON.parse(readFileSync(join(FIXTURE, "metadata.json"), "utf8")) as { sessions: { compact_transcript: string; prompt: string }[] };
    meta.sessions[0]!.compact_transcript = "/0/full.jsonl";
    meta.sessions[0]!.prompt = "/0/full.jsonl";
    writeCheckpointRef(id, {
      "metadata.json": JSON.stringify(meta),
      "0/metadata.json": readFileSync(join(FIXTURE, "0/metadata.json"), "utf8"),
      "0/prompt.txt": readFileSync(join(FIXTURE, "0/prompt.txt"), "utf8"),
      "0/transcript.jsonl": VITEST_RECORD + "\n",
      "0/full.jsonl": JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "pytest RAW-TRANSCRIPT-MUST-NOT-LEAK" } }] }) + "\n",
    });
    const sha = commitFile("src/comment.ts", "export const COMMENT_MARKER = 5;\n", `feat: declared paths\n\nEntire-Checkpoint: ${id}\n`);
    const cp = checkpointFor(repo, sha);
    expect(cp?.testCommands).toEqual(["bunx vitest run src/comment.test.ts"]);
    expect(cp?.prompt.startsWith("In this repo (cwd)")).toBe(true);
    expect(JSON.stringify(cp)).not.toContain("RAW-TRANSCRIPT");
  });

  it("returns undefined instead of throwing for a ref that is not in Entire's layout", () => {
    const id = "01M3AY9296319GSPWRKXGHXMQ2";
    writeCheckpointRef(id, { "metadata.json": "{not json", "0/metadata.json": "{}" });
    const bad = commitFile("src/comment.ts", "export const COMMENT_MARKER = 6;\n", `chore: broken ref\n\nEntire-Checkpoint: ${id}\n`);
    expect(checkpointFor(repo, bad)).toBeUndefined();
    const id2 = "01M3AY9296319GSPWRKXGHXMQ3";
    writeCheckpointRef(id2, { "metadata.json": JSON.stringify({ sessions: [{}] }), "0/metadata.json": "{}" }); // no prompt, no transcript
    const missing = commitFile("src/comment.ts", "export const COMMENT_MARKER = 7;\n", `chore: partial ref\n\nEntire-Checkpoint: ${id2}\n`);
    expect(checkpointFor(repo, missing)).toBeUndefined();
    expect(testCommandsIn("not json\n" + VITEST_RECORD)).toEqual(["bunx vitest run src/comment.test.ts"]);
  });

  it("reports the id but no checkpoint when the trailer names a ref that was not pushed", () => {
    expect(checkpointTrailer(repo, commitDanglingTrailer)).toBe("01M3AY9296319GSPWRKXGHXZZZ");
    expect(checkpointFor(repo, commitDanglingTrailer)).toBeUndefined();
  });

  it("accepts a short sha and returns the full one", () => {
    expect(checkpointFor(repo, commitWithRef.slice(0, 7))?.commit).toBe(commitWithRef);
  });
});

describe("testCommandsIn", () => {
  it("keeps only Bash tool_use commands that name a test runner, deduplicated, in order", () => {
    const record = (command: string): string =>
      JSON.stringify({ v: 1, type: "assistant", content: [{ id: "t", input: { command }, name: "Bash", type: "tool_use" }] });
    const transcript = [
      record("grep -n COMMENT_MARKER src/comment.ts"),
      record("bunx vitest run src/a.test.ts"),
      record("go test ./..."),
      record("bunx vitest run src/a.test.ts"),
      JSON.stringify({ v: 1, type: "assistant", content: [{ id: "e", input: { file_path: "vitest.config.ts" }, name: "Edit", type: "tool_use" }] }),
      JSON.stringify({ v: 1, type: "user", content: [{ id: "u", text: "please run pytest" }] }),
    ].join("\n");
    expect(testCommandsIn(transcript)).toEqual(["bunx vitest run src/a.test.ts", "go test ./..."]);
  });
});

describe("provenanceOf", () => {
  let copilotCloud: string;
  let coAuthored: string;
  let claudeAuthor: string;
  let human: string;
  beforeAll(() => {
    git("commit", "-q", "--allow-empty", "-m", "feat: retry fetch\n\nAgent-Logs-Url: https://github.com/o/r/sessions/01ABC");
    copilotCloud = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "fix: typo\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>");
    coAuthored = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "--author=Claude <noreply@anthropic.com>", "-m", "chore: bump");
    claudeAuthor = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "docs: by hand\n\nCo-authored-by: Pat <pat@example.com>");
    human = git("rev-parse", "HEAD");
  });

  it("reads Copilot's Agent-Logs-Url trailer as the agent and the session-log link", () => {
    expect(provenanceOf(repo, copilotCloud)).toEqual({ agent: "copilot", via: "Agent-Logs-Url", logsUrl: "https://github.com/o/r/sessions/01ABC" });
  });

  it("names the agent from a vendor address in Co-authored-by, dropping GitHub's numeric prefix", () => {
    expect(provenanceOf(repo, coAuthored)).toEqual({ agent: "copilot", via: "Co-authored-by" });
  });

  it("names the agent from a vendor address as the author", () => {
    expect(provenanceOf(repo, claudeAuthor)).toEqual({ agent: "claude-code", via: "author" });
  });

  it("returns nothing for a human's commit, a human co-author, or a checkpointed commit's trailer alone", () => {
    expect(provenanceOf(repo, human)).toBeUndefined();
    expect(provenanceOf(repo, commitNoTrailer)).toBeUndefined();
    expect(provenanceOf(repo, commitWithRef)).toBeUndefined();
  });

  it("matches addresses case-insensitively and only the two vendor addresses", () => {
    expect(agentForAddress("NoReply@Anthropic.com")).toBe("claude-code");
    expect(agentForAddress("12+copilot@users.noreply.github.com")).toBe("copilot");
    expect(agentForAddress("copilot@example.com")).toBeUndefined();
    expect(agentForAddress("t@blastline.invalid")).toBeUndefined();
  });
});

describe("symbolReasonsIn", () => {
  const symbols = [
    { path: "src/comment.ts", label: "COMMENT_MARKER" },
    { path: "src/comment.ts", label: "renderBrief" },
    { path: "src/other.ts", label: "COMMENT_MARKER" },
  ];

  it("attributes a symbol to the last edit on its file that names it, with the agent's last line before that edit", () => {
    expect(symbolReasonsIn(EDIT_RECORDS, symbols)).toEqual([
      { path: "src/comment.ts", label: "COMMENT_MARKER", turn: 2, why: "The marker comment should say what the Action does with it." },
    ]);
  });

  it("treats a Write as touching every symbol of the file, and lets a later edit win", () => {
    const write = JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Rewrite the whole module." }, { type: "tool_use", name: "Write", input: { file_path: "src/comment.ts", content: "nothing named here" } }] });
    const later = JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Rename the marker constant." }, { type: "tool_use", name: "MultiEdit", input: { file_path: "src/comment.ts", edits: [{ old_string: "COMMENT_MARKER", new_string: "MARKER" }] } }] });
    expect(symbolReasonsIn([write, later].join("\n"), symbols)).toEqual([
      { path: "src/comment.ts", label: "COMMENT_MARKER", turn: 2, why: "Rename the marker constant." },
      { path: "src/comment.ts", label: "renderBrief", turn: 1, why: "Rewrite the whole module." },
    ]);
  });

  it("matches names as whole words, skips non-edit tools and unparseable lines, and gives an empty reason when no text preceded the edit", () => {
    const only = JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/comment.ts", old_string: "COMMENT_MARKERS", new_string: "COMMENT_MARKERS2" } }] });
    expect(symbolReasonsIn(only, symbols)).toEqual([]);
    const bash = JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "sed -i s/COMMENT_MARKER/x/ src/comment.ts" } }] });
    expect(symbolReasonsIn(["not json", bash, JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/comment.ts", new_string: "COMMENT_MARKER" } }] })].join("\n"), symbols)).toEqual([
      { path: "src/comment.ts", label: "COMMENT_MARKER", turn: 2, why: "" },
    ]);
    expect(editNames("$state", "const $state = 1;")).toBe(true);
    expect(editNames("parse", "parseAll(x)")).toBe(false);
  });
});

describe("symbolReasonsIn by line range", () => {
  it("attributes an edit inside a symbol's body to that symbol when the written text sits in its range as committed", () => {
    const content = "/** doc */\nexport const COMMENT_MARKER = 1;\n\nexport function renderHeader(n: number): string {\n  return [COMMENT_MARKER, `### ${n}`].join(\"\\n\");\n}\n";
    const edit = JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Build the header from a list." }, { type: "tool_use", name: "Edit", input: { file_path: "src/comment.ts", old_string: "return `x`;", new_string: "  return [COMMENT_MARKER, `### ${n}`].join(\"\\n\");" } }] });
    const symbols = [
      { path: "src/comment.ts", label: "COMMENT_MARKER", from: 2, to: 2 },
      { path: "src/comment.ts", label: "renderHeader", from: 4, to: 6 },
    ];
    const reasons = symbolReasonsIn(edit, symbols, () => content);
    expect(reasons.map((r) => r.label).sort()).toEqual(["COMMENT_MARKER", "renderHeader"]);
    // without the committed content the body edit only reaches the symbol it names
    expect(symbolReasonsIn(edit, symbols).map((r) => r.label)).toEqual(["COMMENT_MARKER"]);
    // text that was later changed again is not found as committed, so the name match still applies
    expect(symbolReasonsIn(edit, symbols, () => "unrelated file\n").map((r) => r.label)).toEqual(["COMMENT_MARKER"]);
  });

  it("counts every occurrence of text that appears in several places, so no symbol holding one is missed", () => {
    const content = "function a() {\n  return x;\n}\n\nfunction b() {\n  return x;\n}\n";
    expect(writtenWithin(content, "  return x;", 1, 3)).toBe(true);
    expect(writtenWithin(content, "  return x;", 5, 7)).toBe(true);
    expect(writtenWithin(content, "  return x;", 4, 4)).toBe(false);
    expect(writtenWithin(content, "", 1, 7)).toBe(false);
    expect(writtenWithin(content, "function b() {\n  return x;", 1, 4)).toBe(false);
    expect(writtenWithin(content, "function b() {\n  return x;", 6, 6)).toBe(true);
  });
});

describe("checkpointFor with symbols", () => {
  it("returns the reasons for the symbols asked about and nothing from the edit's contents or result", () => {
    const cp = checkpointFor(repo, commitEdited, [{ path: "src/comment.ts", label: "COMMENT_MARKER" }, { path: "src/comment.ts", label: "nope" }]);
    expect(cp?.reasons).toEqual([{ path: "src/comment.ts", label: "COMMENT_MARKER", turn: expect.any(Number), why: "The marker comment should say what the Action does with it." }]);
    expect(JSON.stringify(cp)).not.toContain("SECRET-EDIT-RESULT");
    expect(JSON.stringify(cp)).not.toContain("Second line");
    expect(checkpointFor(repo, commitEdited)?.reasons).toEqual([]);
  });
});
