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

describe("prompts the harness writes", () => {
  it("are not a person's turn: Stop hook feedback, an interrupt marker, a compaction summary, usage-limit notices", () => {
    // Real openings from turing-webapp's checkpoint transcripts; Stop hook feedback alone was 1,532 records.
    for (const harness of [
      "Stop hook feedback:\n[~/.agents/hooks/stop.sh]: keep going",
      "[Request interrupted by user for tool use]",
      "This session is being continued from a previous conversation that ran out of context.",
      "[Usage limit reached; a short grace allowance remains]",
      "[Earlier usage-limit notes no longer apply. Continue working normally.]",
      "Your claude.ai usage limit has reset. Continue the task you were working on.",
    ]) {
      expect(typedByPerson(harness)).toBe(false);
      expect(promptLine(`${harness}\n\n---\n\nput the router-driven key back`)).toBe("put the router-driven key back");
    }
  });

  it("skip an attached image's caption and keep what the person typed with it", () => {
    expect(typedByPerson("[Image: source: /private/tmp/x/1.png]")).toBe(true);
    expect(promptLine("[Image: source: /private/tmp/x/1.png]\nthe header overlaps on mobile")).toBe("the header overlaps on mobile");
  });
});

describe("transcriptHash", () => {
  it("identifies a stamped record by type, stamp and id, so a result filled in later changes nothing, and an id-less record by its text", () => {
    const stamped = (result?: object): string => JSON.stringify({ type: "assistant", ts: "2026-09-26T02:19:45.518Z", id: "msg_1", content: [{ type: "tool_use", name: "Bash", input: { command: "git commit" }, ...(result && { result }) }] });
    expect(transcriptHash([stamped()])).toBe(transcriptHash([stamped({ output: "[main abc] x" })]));
    const idless = (command: string): string => JSON.stringify({ v: 1, type: "assistant", ts: "2026-09-24T16:23:46.000Z", content: [{ type: "tool_use", name: "Bash", input: { command } }] });
    expect(transcriptHash([idless("bunx vitest run a.test.ts")])).not.toBe(transcriptHash([idless("bunx vitest run b.test.ts")]));
    expect(transcriptHash(["not json"])).not.toBe(transcriptHash(["also not json"]));
  });
});

// Entire 0.10.0 branch backend: 12-hex ids, one shared branch, <first two>/<rest>/ directories.
const HEX_A = "c892ec03a62e";
const HEX_B = "782a9bbcae1b";
const HEX_C = "dd54cfcde765";
const SESSION = "0d2e1746-ad6a-45c2-a9c8-371131273a49";
const stamp = (n: number): string => `2026-09-26T02:${String(n).padStart(2, "0")}:00.000Z`;
const rec = (type: string, ts: string, content: object[], extra: object = {}): string => JSON.stringify({ v: 1, agent: "claude-code", cli_version: "0.10.0", type, ts, id: `msg_${ts}`, content, ...extra });
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
  rec("user", stamp(29), [user("the bot's autofix broke the page key; put the router-driven one back")]),
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
    // The turn ran the tests once, before both commits; each carries the run, or the claim check would refute the second.
    expect(b?.testCommands).toEqual(["bunx vitest run src/round-size.test.ts"]);
    expect(b?.sessions).toEqual([{ id: SESSION, lines: 10, hash: HASH_A }]);
    // The last record of A's snapshot is stamped after A's created_at; a time boundary would hand it to C as well.
    const c = checkpointFor(repo, commitC, [], new Map([[SESSION, { sha: commitB, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(c?.narration).toEqual({ started: "All checks pass on the tip, but CodeRabbit pushed one more autofix. Reviewing it before merging.", ended: "", texts: 1, tools: 1 });
    expect(c?.sameStepAs).toBeUndefined();
    // C's turn opens with what the person typed, though its prompt.txt holds only notifications.
    expect(c?.prompt).toBe("the bot's autofix broke the page key; put the router-driven one back");
    expect(c?.sessions).toEqual([{ id: SESSION, lines: 13, hash: HASH_C }]);
    // A later turn's commit does not inherit an earlier turn's run: its own turn ran nothing.
    expect(c?.testCommands).toEqual([]);
  });

  it("still extends a snapshot whose last tool call gained its result since, as Entire fills results in later", () => {
    // Real shape: 0ec8874549e6's last record is the commit's Bash call without `result`; 5cc9e7709e27 carries the same record with it.
    const withoutResult = [...CUMULATIVE.slice(0, 8), rec("assistant", stamp(10), [{ id: "b", type: "tool_use", name: "Bash", input: { command: "bunx vitest run src/round-size.test.ts" } }]), CUMULATIVE[9]!];
    expect(transcriptHash(withoutResult)).toBe(transcriptHash(CUMULATIVE));
    const w = windowsOf(CUMULATIVE_C.join("\n"), { sha: "a", lines: 10, hash: transcriptHash(withoutResult) }, ["src/round-size.ts"]);
    expect(w.extended).toBe(true);
    expect(w.sinceWindow.split("\n")).toHaveLength(3);
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
    const d = checkpointFor(repo, commitTwoSessions, [], new Map([[SESSION, { sha: commitC, lines: 13, hash: HASH_C }]]), ["src/round-size.ts"]);
    const other = [rec("user", stamp(20), [user("in the other session")]), rec("assistant", stamp(21), [text("Other session at work."), bash("bunx vitest run src/other.test.ts")])];
    expect(d?.sessions).toEqual([
      { id: SESSION, lines: 13, hash: HASH_C },
      { id: OTHER, lines: 2, hash: transcriptHash(other) },
    ]);
    expect(d?.narration).toEqual({ started: "Other session at work.", ended: "", texts: 1, tools: 1 });
    expect(d?.testCommands).toEqual(["bunx vitest run src/other.test.ts"]);
    expect(d?.sameStepAs).toBeUndefined();
    const again = checkpointFor(repo, commitTwoSessions, [], new Map([[SESSION, { sha: commitC, lines: 13, hash: HASH_C }], [OTHER, { sha: commitC, lines: 2, hash: transcriptHash(other) }]]), ["src/round-size.ts"]);
    expect(again?.sameStepAs).toBe(commitC);
  });

  it("takes the ask from the session that worked on the commit's files, not one that ran alongside", () => {
    // Session 0 extends what commit C read and only talks; the other session edits the file.
    const HEX_F = "5f0a1c2d3e4b";
    const talk = [...CUMULATIVE_C, rec("user", stamp(40), [user("other session: tidy the README")]), rec("assistant", stamp(41), [text("Tidying.")])];
    const files = branchFiles(HEX_F, stamp(42), talk, "", { session: OTHER, transcript: [rec("user", stamp(20), [user("put the minimum back")]), rec("assistant", stamp(21), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;")])] });
    writeBranchCheckpoint(HEX_F, files);
    const f = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 12;\n", `fix: two sessions, one at work\n\nEntire-Checkpoint: ${HEX_F}\n`);
    const cp = checkpointFor(repo, f, [], new Map([[SESSION, { sha: commitC, lines: 13, hash: HASH_C }]]), ["src/round-size.ts"]);
    expect(cp?.prompt).toBe("put the minimum back");
  });

  it("finds a symbol's reason in the since-window even when the narration window starts later", () => {
    const cp = checkpointFor(repo, commitA, [{ path: "src/round-size.ts", label: "ROUND_SIZE_MAX" }], new Map(), ["src/round-size.ts"]);
    expect(cp?.reasons).toEqual([{ path: "src/round-size.ts", label: "ROUND_SIZE_MAX", turn: 4, why: "I'll start by reading the ticket, then set up a worktree off dev." }]);
  });

  it("reads a checkpoint whose sessions have no prompt.txt, as Entire leaves some", () => {
    const HEX_E = "21220caeedd7";
    const files = branchFiles(HEX_E, stamp(9), CUMULATIVE, "");
    delete files["0/prompt.txt"];
    writeBranchCheckpoint(HEX_E, files);
    const e = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 11;\n", `fix: no prompt file\n\nEntire-Checkpoint: ${HEX_E}\n`);
    const cp = checkpointFor(repo, e, [], new Map(), ["src/round-size.ts"]);
    expect(cp?.id).toBe(HEX_E);
    expect(cp?.prompt).toBe("now give the round-size cap one home");
    expect(cp?.narration.started).toBe("I'll start by reading the ticket, then set up a worktree off dev.");
  });

  it("reads decisions from the commit's own turn, and calls what the person says in a later commit's part steering", () => {
    const a = checkpointFor(repo, commitA, [], new Map(), ["src/round-size.ts"]);
    // The earlier turn about the ticket list is not this commit's, and its own opening request is the Intent column's.
    expect(a?.decisions).toEqual([]);
    // Commit C's part holds no tool call on its files (a revert by commit id), so it is read for nothing.
    const c = checkpointFor(repo, commitC, [], new Map([[SESSION, { sha: commitB, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(c?.decisions).toEqual([]);
    // A commit whose files no tool call touched, with nothing read before: the turn is unknown, so no decisions.
    expect(checkpointFor(repo, commitA, [], new Map(), ["src/elsewhere.ts"])?.decisions).toEqual([]);
  });

  it("reads none of an unrelated task between two checkpoints, only the turns that work on the commit's files", () => {
    const HEX_U = "7c3e9a1b2d4f";
    const between = [
      ...CUMULATIVE,
      rec("user", stamp(50), [user("unrelated: draft the reply about the Q4 list")]),
      rec("assistant", stamp(51), [bash("git reset --hard origin/other")]),
      rec("user", stamp(52), [user("now back to the cap, also handle zero")]),
      rec("assistant", stamp(53), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;")]),
      rec("user", stamp(54), [user("keep the minimum at one for the eval harness")]),
      rec("assistant", stamp(55), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;"), bash("git revert --no-edit HEAD")]),
    ];
    writeBranchCheckpoint(HEX_U, branchFiles(HEX_U, stamp(56), between, ""));
    const u = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;\n", `fix: the cap handles zero\n\nEntire-Checkpoint: ${HEX_U}\n`);
    const cp = checkpointFor(repo, u, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(cp?.decisions.map((d) => [d.kind, d.text])).toEqual([["reverted", "git revert"]]);
  });

  it("reads none of an aside after the commit's work, nor a session that only names a file with the same basename", () => {
    const HEX_V = "8d4f0b2c3e5a";
    const aside = [
      ...CUMULATIVE,
      rec("user", stamp(60), [user("now let the cap take zero")]),
      rec("assistant", stamp(61), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;")]),
      rec("user", stamp(62), [user("unrelated: draft the reply about the Q4 list")]),
      rec("assistant", stamp(63), [bash("git reset --hard origin/other")]),
    ];
    const alongside = [
      rec("user", stamp(20), [user("the invoice totals are wrong for the refunds")]),
      rec("assistant", stamp(21), [bash("cat services/billing/round-size.ts"), bash("git reset --hard origin/other")]),
    ];
    writeBranchCheckpoint(HEX_V, branchFiles(HEX_V, stamp(64), aside, "", { session: OTHER, transcript: alongside }));
    const v = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;\n", `fix: the cap takes zero\n\nEntire-Checkpoint: ${HEX_V}\n`);
    const cp = checkpointFor(repo, v, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(cp?.decisions).toEqual([]);
  });

  it("reads no turn that works on another repo's file of the same root-level name", () => {
    const HEX_W = "9e5a1c3d4f6b";
    const sibling = [
      ...CUMULATIVE,
      rec("user", stamp(70), [user("bump the cap's package and fix round-size")]),
      rec("assistant", stamp(71), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 2;")]),
      rec("user", stamp(72), [user("the invoice totals are wrong for the refunds")]),
      rec("assistant", stamp(73), [bash("cat ../billing-service/package.json"), bash("git reset --hard origin/other")]),
      rec("user", stamp(74), [user("and the billing manifest too")]),
      rec("assistant", stamp(75), [{ id: "e2", type: "tool_use", name: "Edit", input: { file_path: "/Users/x/billing/package.json", old_string: "a", new_string: "b" }, result: { output: "", status: "success" } }, bash("git reset --hard origin/other")]),
    ];
    writeBranchCheckpoint(HEX_W, branchFiles(HEX_W, stamp(76), sibling, ""));
    const w = commitFile("package.json", "{}\n", `chore: bump\n\nEntire-Checkpoint: ${HEX_W}\n`);
    const cp = checkpointFor(repo, w, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["package.json", "src/round-size.ts"]);
    expect(cp?.decisions).toEqual([]);
  });

  it("reads a command only by the absolute path at this repo's root: a cd into another repo and a relative path count for nothing", () => {
    const HEX_X = "a1b2c3d4e5f6";
    const elsewhere = [
      ...CUMULATIVE,
      rec("user", stamp(80), [user("let the cap take zero")]),
      rec("assistant", stamp(81), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;")]),
      rec("user", stamp(82), [user("check the billing manifest")]),
      rec("assistant", stamp(83), [bash("cd ../billing && cat package.json"), bash("git reset --hard origin/other")]),
      rec("user", stamp(84), [user("and its cap")]),
      rec("assistant", stamp(85), [bash("cd ~/billing && sed -n 1,5p src/round-size.ts"), bash("git reset --hard origin/other")]),
      rec("user", stamp(86), [user("tidy ours")]),
      rec("assistant", stamp(87), [bash("sed -i s/0/1/ /Users/x/wt/src/round-size.ts"), bash("git revert --no-edit HEAD")]),
    ];
    writeBranchCheckpoint(HEX_X, branchFiles(HEX_X, stamp(88), elsewhere, ""));
    const x = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;\n", `fix: the cap minimum\n\nEntire-Checkpoint: ${HEX_X}\n`);
    const cp = checkpointFor(repo, x, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["package.json", "src/round-size.ts"]);
    expect(cp?.decisions.map((d) => d.text)).toEqual(["git revert"]);
  });

  it("reads the unread part of a turn the previous checkpoint read the start of, when that turn worked on the files", () => {
    const HEX_Z = "c3d4e5f6a1b2";
    // CUMULATIVE ends inside the turn that edited src/round-size.ts; this checkpoint holds the rest of that turn.
    const rest = [...CUMULATIVE, rec("assistant", stamp(12), [bash("git add src/round-size.ts"), bash("git revert --no-edit HEAD")])];
    writeBranchCheckpoint(HEX_Z, branchFiles(HEX_Z, stamp(13), rest, ""));
    const z = commitFile("src/round-size.ts", "export const ROUND_SIZE_MAX = 8;\n", `fix: the cap pages by eight\n\nEntire-Checkpoint: ${HEX_Z}\n`);
    const cp = checkpointFor(repo, z, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(cp?.decisions.map((d) => d.text)).toEqual(["git revert"]);
  });

  it("reads nothing the agent does after it leaves the repo inside a turn, until it works at the root again", () => {
    const HEX_M = "d4e5f6a1b2c3";
    const mixed = [
      ...CUMULATIVE,
      rec("user", stamp(100), [user("let the cap take zero, and compare billing")]),
      rec("assistant", stamp(101), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;")]),
      rec("assistant", stamp(102), [bash("cd /Users/x/billing && cat package.json")]),
      rec("assistant", stamp(103), [bash("git reset --hard origin/other")]),
      rec("assistant", stamp(104), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;")]),
      rec("assistant", stamp(105), [bash("git revert --no-edit HEAD")]),
      rec("assistant", stamp(106), [bash("diff /Users/x/wt/src/round-size.ts /Users/x/billing/src/round-size.ts")]),
      rec("assistant", stamp(107), [bash("git reset --hard origin/other")]),
    ];
    writeBranchCheckpoint(HEX_M, branchFiles(HEX_M, stamp(108), mixed, ""));
    const m = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;\n", `fix: the cap minimum is one\n\nEntire-Checkpoint: ${HEX_M}\n`);
    const cp = checkpointFor(repo, m, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(cp?.decisions.map((d) => d.text)).toEqual(["git revert"]);
  });

  it("reads nothing after any way of leaving the repo, across turns, and keeps work after a quoted route", () => {
    const tool = (name: string, input: object): object => ({ id: "t", type: "tool_use", name, input, result: { output: "", status: "success" } });
    // What the agent does while away must not be read: a hard reset there would show as a revert.
    const AWAY = bash("git reset --hard origin/other");
    const shapes: [string, object[]][] = [
      ["relative path", [bash("cat ../billing/.env")]],
      ["git -C", [bash("git -C ../billing log -3")]],
      ["pushd", [bash("pushd ../billing && cat .env")]],
      ["variable", [bash("cat $HOME/billing/.env")]],
      ["then cd", [bash("if true; then cd ../billing; fi")]],
      ["Read", [tool("Read", { file_path: "/Users/x/billing/.env" })]],
      ["Grep", [tool("Grep", { pattern: "rate", path: "/Users/x/billing" })]],
      ["absolute", [bash("cat /Users/x/billing/.env")]],
    ];
    shapes.forEach(([label, step], n) => {
      const id = `e${n}f6a1b2c3d4`.slice(0, 12);
      const t = [...CUMULATIVE, rec("user", stamp(110), [user("let the cap take zero")]), rec("assistant", stamp(111), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;")]), rec("assistant", stamp(112), step), rec("assistant", stamp(113), [AWAY])];
      writeBranchCheckpoint(id, branchFiles(id, stamp(114), t, ""));
      const c = commitFile("src/round-size.ts", `export const ROUND_SIZE_MIN = ${n};\n`, `fix: shape ${n}\n\nEntire-Checkpoint: ${id}\n`);
      expect(checkpointFor(repo, c, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"])?.decisions, label).toEqual([]);
    });
    // The shell keeps its directory into the next turn, and a quoted route in a search is not a place.
    const ID = "f9e8d7c6b5a4";
    const t = [
      ...CUMULATIVE,
      rec("user", stamp(120), [user("let the cap take zero")]),
      rec("assistant", stamp(121), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;"), bash("cd /Users/x/billing")]),
      rec("user", stamp(122), [user("what does it read")]),
      rec("assistant", stamp(123), [bash("cat .env"), AWAY]),
      rec("assistant", stamp(124), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;"), bash("grep -rn '/api/v1' /Users/x/wt/src")]),
      rec("assistant", stamp(125), [bash("git revert --no-edit HEAD")]),
    ];
    writeBranchCheckpoint(ID, branchFiles(ID, stamp(126), t, ""));
    const c = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 1;\n", `fix: across turns\n\nEntire-Checkpoint: ${ID}\n`);
    expect(checkpointFor(repo, c, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"])?.decisions.map((d) => d.text)).toEqual(["git revert"]);
  });

  it("reads nothing when edits name two checkouts of the same layout", () => {
    const HEX_Y = "b2c3d4e5f6a1";
    const two = [
      ...CUMULATIVE,
      rec("user", stamp(90), [user("let the cap take zero")]),
      rec("assistant", stamp(91), [{ id: "o", type: "tool_use", name: "Edit", input: { file_path: "/Users/x/billing/src/round-size.ts", old_string: "a", new_string: "b" }, result: { output: "", status: "success" } }]),
      rec("user", stamp(92), [user("now ours")]),
      rec("assistant", stamp(93), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;"), bash("git reset --hard origin/other")]),
    ];
    writeBranchCheckpoint(HEX_Y, branchFiles(HEX_Y, stamp(94), two, ""));
    const y = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;\n", `fix: the cap takes zero again\n\nEntire-Checkpoint: ${HEX_Y}\n`);
    const cp = checkpointFor(repo, y, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    expect(cp?.decisions).toEqual([]);
  });

  it("reads, between two checkouts of the same layout, the one the commit was made in", () => {
    const HEX_K = "c3d4e5f6a1b2";
    const two = [
      ...CUMULATIVE,
      rec("user", stamp(70), [user("let the cap take zero")]),
      rec("assistant", stamp(71), [{ id: "o", type: "tool_use", name: "Edit", input: { file_path: "/Users/x/billing/src/round-size.ts", old_string: "a", new_string: "b" }, result: { output: "", status: "success" } }, bash("cd /Users/x/billing && git reset --hard origin/other")]),
      rec("user", stamp(72), [user("now ours")]),
      rec("assistant", stamp(73), [edit("src/round-size.ts", "export const ROUND_SIZE_MIN = 0;"), bash("cd /Users/x/wt && git revert --no-edit HEAD && git commit -qm cap")]),
    ];
    writeBranchCheckpoint(HEX_K, branchFiles(HEX_K, stamp(74), two, ""));
    const k = commitFile("src/round-size.ts", "export const ROUND_SIZE_MIN = 0; // where it was made\n", `fix: the cap takes zero once more\n\nEntire-Checkpoint: ${HEX_K}\n`);
    const cp = checkpointFor(repo, k, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), ["src/round-size.ts"]);
    // The reset in the other checkout is not this commit's; the revert where the commit was made is.
    expect(cp?.decisions.map((d) => d.text)).toEqual(["git revert"]);
  });

  it("follows an agent that edits through scripts: the shell's directory, kept across calls and `cd \"$PWD\"`", () => {
    const HEX_S = "d4e5f6a1b2c3";
    const out = (o: string, command: string): object => ({ id: "s", type: "tool_use", name: "Bash", input: { command }, result: { output: o, status: "success" } });
    const scripted = [
      ...CUMULATIVE,
      rec("user", stamp(60), [user("the cap needs a floor too")]),
      rec("assistant", stamp(61), [out("", "cd /Users/x/wt && python3 - <<'EOF'\nopen('src/round-size.ts','a').write('x')\nEOF")]),
      rec("assistant", stamp(62), [out("      Tests  1 failed | 4 passed (5)", 'cd "$PWD"; bunx vitest run src/round-size.test.ts 2>&1 | tail -3')]),
      rec("assistant", stamp(63), [out("      Tests  5 passed (5)", 'cd "$PWD"; bunx vitest run src/round-size.test.ts 2>&1 | tail -3; git status --short')]),
    ];
    writeBranchCheckpoint(HEX_S, branchFiles(HEX_S, stamp(64), scripted, ""));
    const sc = commitFile("src/round-size.test.ts", "test('floor', () => {});\n", `test: the cap has a floor\n\nEntire-Checkpoint: ${HEX_S}\n`);
    const files = ["src/round-size.ts", "src/round-size.test.ts"];
    const cp = checkpointFor(repo, sc, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), files, files);
    expect(cp?.decisions.map((d) => d.text)).toEqual(["`vitest` on `src/round-size.test.ts` failed, then passed"]);
  });

  it("reads a subagent's tool calls inside the turn that started it, only when Entire kept its transcript", () => {
    const HEX_T = "e5f6a1b2c3d4";
    const delegated = [
      ...CUMULATIVE,
      rec("user", stamp(80), [user("hand the floor to a subagent")]),
      rec("assistant", stamp(81), [{ id: "toolu_01Floor", type: "tool_use", name: "Agent", input: { subagent_type: "general-purpose", description: "floor" }, result: { output: "done", status: "success" } }]),
    ];
    // A subagent's transcript is raw Claude Code JSONL: results arrive as tool_result records.
    const raw = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const use = (id: string, name: string, input: object): object => ({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, content: string, is_error = false): object => ({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
    const subagent = raw(
      { type: "user", isSidechain: true, message: { role: "user", content: "SUBAGENT PROMPT MUST NOT COUNT AS A TURN" } },
      use("toolu_a", "Edit", { file_path: "/Users/x/wt/src/round-size.ts", old_string: "a", new_string: "b" }),
      result("toolu_a", "ok"),
      use("toolu_b", "Bash", { command: "cd /Users/x/wt && bunx vitest run src/round-size.test.ts 2>&1 | tail -2" }),
      result("toolu_b", "      Tests  1 failed (1)"),
      use("toolu_c", "Bash", { command: "cd /Users/x/wt && bunx vitest run src/round-size.test.ts 2>&1 | tail -2" }),
      result("toolu_c", "      Tests  1 passed (1)"),
    );
    const files = ["src/round-size.ts", "src/round-size.test.ts"];
    writeBranchCheckpoint(HEX_T, branchFiles(HEX_T, stamp(82), delegated, ""));
    const bare = commitFile("src/round-size.test.ts", "test('floor by a subagent', () => {});\n", `test: a subagent adds the floor\n\nEntire-Checkpoint: ${HEX_T}\n`);
    expect(checkpointFor(repo, bare, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), files, files)?.decisions).toEqual([]);
    writeBranchCheckpoint(HEX_T, { "tasks/toolu_01Floor/agent-a1b2c3.jsonl": subagent });
    const cp = checkpointFor(repo, bare, [], new Map([[SESSION, { sha: commitA, lines: 10, hash: HASH_A }]]), files, files);
    expect(cp?.decisions.map((d) => d.text)).toEqual(["`vitest` on `src/round-size.test.ts` failed, then passed"]);
    // Only the decision window reads the subagent: the commit's ask and test commands stay the parent's.
    expect(cp?.testCommands).toEqual([]);
  });

  it("reports the id but no checkpoint when the branch does not hold it", () => {
    expect(checkpointTrailer(repo, commitMissing)).toBe("0123456789ab");
    expect(checkpointFor(repo, commitMissing)).toBeUndefined();
  });
});

describe("windowsOf and narrationIn", () => {
  it("does not end the commit's turn at a Stop hook's feedback, which arrives after every reply", () => {
    const t = [
      rec("user", stamp(1), [user("move the cap into one module")]),
      rec("assistant", stamp(2), [text("Found the cap in three places; one module will own it."), edit("src/a.ts", "x")]),
      rec("user", stamp(3), [user("Stop hook feedback:\n[~/.agents/hooks/stop.sh]: tests not run")]),
      rec("assistant", stamp(4), [text("Running the tests before committing."), bash("bunx vitest run src/round-size.test.ts")]),
      rec("user", stamp(5), [user("Stop hook feedback:\n[~/.agents/hooks/stop.sh]: commit")]),
      rec("assistant", stamp(6), [text("Committed."), edit("src/round-size.ts", "export const ROUND_SIZE_MAX = 8;")]),
    ].join("\n");
    const w = windowsOf(t, undefined, ["src/round-size.ts"]);
    expect(w.ask).toBe("move the cap into one module");
    expect(narrationIn(w.stepWindow)).toEqual({ started: "Found the cap in three places; one module will own it.", ended: "Committed.", texts: 3, tools: 3 });
    expect(testCommandsIn(w.turnWindow)).toEqual(["bunx vitest run src/round-size.test.ts"]);
    // No tool call works on the commit's files (a subagent edited them) and nothing bounds the transcript: no ask is guessed.
    expect(windowsOf(t, undefined, ["src/elsewhere.ts"]).ask).toBe("");
  });

  it("never takes the ask from a block the harness appended to a person's turn", () => {
    // An image sent with no typed text, and a reminder whose body has a --- rule and a line that reads like a request.
    const t = [
      rec("user", stamp(1), [user("[Image: source: /Users/t/Desktop/s.png]"), user("<system-reminder>\nCLAUDE.md says:\n---\nNever push to main without review\n</system-reminder>")]),
      rec("assistant", stamp(2), [edit("src/round-size.ts", "x")]),
    ].join("\n");
    expect(windowsOf(t, undefined, ["src/round-size.ts"]).ask).toBe("");
    const typed = [rec("user", stamp(1), [user("[Image: source: /Users/t/Desktop/s.png]"), user("the cap is wrong on this screen")]), rec("assistant", stamp(2), [edit("src/round-size.ts", "x")])].join("\n");
    expect(windowsOf(typed, undefined, ["src/round-size.ts"]).ask).toBe("the cap is wrong on this screen");
    // A session launched through `agents run` opens with its preamble, which names a local path.
    const launched = [rec("user", stamp(1), [user("You are in a git worktree of blastline on branch fix/x at /home/t/wt.\nfix the login redirect")]), rec("assistant", stamp(2), [edit("src/round-size.ts", "x")])].join("\n");
    expect(windowsOf(launched, undefined, ["src/round-size.ts"]).ask).toBe("fix the login redirect");
  });

  it("asks of the new part's last prompt when the commit's files were edited where the transcript cannot see", () => {
    const before = [rec("user", stamp(1), [user("turn A: move the cap")]), rec("assistant", stamp(2), [edit("src/round-size.ts", "x")])];
    const after = [...before, rec("assistant", stamp(3), [text("Committed A.")]), rec("user", stamp(4), [user("turn B: drop the dead flag")]), rec("assistant", stamp(5), [text("Handing it to a subagent.")])];
    const read = { sha: "a", lines: 2, hash: transcriptHash(before) };
    expect(windowsOf(after.join("\n"), read, ["src/flags.ts"])).toMatchObject({ ask: "turn B: drop the dead flag", worked: false, extended: true });
    // Nothing typed since the last read: the same step as the earlier commit, so its turn's ask.
    const same = [...before, rec("assistant", stamp(3), [text("Committed A.")])];
    expect(windowsOf(same.join("\n"), read, ["src/flags.ts"]).ask).toBe("turn A: move the cap");
  });

  it("keeps an unstamped transcript whole and counts texts and tool calls", () => {
    const t = [JSON.stringify({ type: "assistant", content: [text("a"), bash("ls")] }), "not json", JSON.stringify({ type: "assistant", content: [text("b")] })].join("\n");
    const lines = t.split("\n");
    expect(windowsOf(t, undefined, ["x.ts"])).toEqual({ sinceWindow: t, stepWindow: t, turnWindow: t, lines: 3, hash: transcriptHash(lines), extended: false, ask: "", worked: false, decisionWindow: "" });
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
    expect(w.turnWindow).toBe(w.stepWindow);
    expect(narrationIn(w.stepWindow).started).toBe("editing with a script");
    // Read up to the script: the narration is what came after, the turn's runs are the whole turn's.
    const later = windowsOf(t, { sha: "x", lines: 5, hash: transcriptHash(t.split("\n").slice(0, 5)) }, ["app/(protected)/lib/use-round-size.ts"]);
    expect(later.stepWindow.split("\n")).toHaveLength(1);
    expect(later.turnWindow.split("\n")).toHaveLength(4);
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
      decisions: [],
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
