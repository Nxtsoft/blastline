import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentForAddress, checkpointFor, checkpointRef, checkpointTrailer, editNames, promptLine, provenanceOf, symbolReasonsIn, testCommandsIn } from "./checkpoint.js";

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
