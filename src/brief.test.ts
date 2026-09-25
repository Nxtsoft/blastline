import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedDeclarationClaims, declares, narrativeClaims, buildBrief, commandRuns, concurrentPrs, othersIn, reviewsIn, parseChangeContext, snapshotIn, SNAPSHOT_MARKER } from "./brief.js";
import { parseUnifiedDiff } from "./diff.js";
import { loadGraph } from "./graph.js";
import { checkpointRef } from "./checkpoint.js";
import { DatabaseSync } from "node:sqlite";

// src/testdata/brief/ is real cgraph bin-v0.4.0 output over the six-file repo
// this test writes below: base-graph.json and head-graph.json are the two
// snapshots' graphs with /repo for the root and `repo_` for the id prefix,
// head.diff is the unified-0 diff between them, and change-context.json is
// `cgraph change-context --budget 6000` over that diff. The head removes
// `helper` from src/lib.ts while src/use.ts (untouched) still calls it, changes
// `parse`, adds `emit`, and edits src/lib.test.ts.
const FIXTURE = fileURLToPath(new URL("./testdata/brief/", import.meta.url));
const CHECKPOINT_FIXTURE = fileURLToPath(new URL("./testdata/checkpoint-ref/", import.meta.url));
const ID = "01M3AY9296319GSPWRKXGHXMH5";

let repo: string;
let base: string;
let libCommit: string;
let testCommit: string;
let headGraph: string;
let baseGraph: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@blastline.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function blob(content: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
}

function write(path: string, content: string): void {
  writeFileSync(join(repo, path), content);
}

function commitAll(message: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "blastline-brief-"));
  git("init", "-q");
  mkdirSync(join(repo, "src"));
  write("src/lib.ts", "export function helper(n: number): number {\n  return n + 1;\n}\n\nexport function parse(input: string): number {\n  return helper(input.length);\n}\n");
  write("src/use.ts", 'import { helper, parse } from "./lib.js";\n\nexport function use(input: string): number {\n  return parse(input) + helper(1);\n}\n');
  write("src/lib.test.ts", 'import { parse } from "./lib.js";\n\nexport const check = parse("ab") === 3;\n');
  write("src/use.test.ts", 'import { use } from "./use.js";\n\nexport const check = use("ab") === 5;\n');
  write("src/other.ts", "export function other(): number {\n  return 2;\n}\n");
  write("src/other.test.ts", 'import { other } from "./other.js";\n\nexport const check = other() === 2;\n');
  base = commitAll("fixture: base");

  // Commit 1: the agent's commit, with a checkpoint whose session ran one of
  // the two reaching tests and touched a file it never committed.
  const fixture = (p: string): string => readFileSync(join(CHECKPOINT_FIXTURE, p), "utf8");
  const meta = JSON.parse(fixture("metadata.json")) as { files_touched: string[] };
  meta.files_touched = ["src/lib.ts", "src/scratch.ts"];
  const ran = JSON.stringify({
    v: 1,
    type: "assistant",
    content: [{ id: "t", input: { command: "bunx vitest run src/lib.test.ts" }, name: "Bash", type: "tool_use" }],
  });
  const entries: Record<string, string> = {
    "metadata.json": JSON.stringify(meta),
    "0/metadata.json": fixture("0/metadata.json"),
    "0/prompt.txt": "Remove helper from src/lib.ts and inline it into parse; add emit.\nsecond line is never shown",
    "0/transcript.jsonl": fixture("0/transcript.jsonl").trimEnd() + "\n" + ran + "\n",
  };
  const inner = Object.entries(entries)
    .filter(([p]) => p.startsWith("0/"))
    .map(([p, c]) => `100644 blob ${blob(c)}\t${p.slice(2)}`)
    .join("\n");
  const innerTree = execFileSync("git", ["-C", repo, "mktree"], { input: inner + "\n", encoding: "utf8" }).trim();
  const rootTree = execFileSync("git", ["-C", repo, "mktree"], {
    input: `100644 blob ${blob(entries["metadata.json"] as string)}\tmetadata.json\n040000 tree ${innerTree}\t0\n`,
    encoding: "utf8",
  }).trim();
  git("update-ref", checkpointRef(ID), git("commit-tree", rootTree, "-m", `Finalize transcript for Checkpoint: ${ID}`));
  write("src/lib.ts", "export function parse(input: string): number {\n  return input.length + 1;\n}\n\nexport function emit(n: number): string {\n  return String(n);\n}\n");
  libCommit = commitAll(`refactor(lib): inline helper, add emit\n\nEntire-Checkpoint: ${ID}\n`);

  // Commit 2: a human commit, no checkpoint.
  write("src/lib.test.ts", 'import { emit, parse } from "./lib.js";\n\nexport const check = parse("ab") === 3 && emit(3) === "3";\n');
  testCommit = commitAll("test(lib): cover emit");

  // The fixture graphs were built at /repo; the selection relativizes graph
  // paths against the repo it runs in, so point them at this checkout. Written
  // after the commits: a graph older than the head commit is stale by rule.
  for (const side of ["base", "head"]) {
    const graph = readFileSync(join(FIXTURE, `${side}-graph.json`), "utf8").split("/repo").join(repo);
    writeFileSync(join(repo, `${side}-graph.json`), graph);
  }
  headGraph = join(repo, "head-graph.json");
  baseGraph = join(repo, "base-graph.json");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function brief(extra: Record<string, unknown> = {}) {
  return buildBrief({
    repo,
    range: `${base}..${testCommit}`,
    graphPath: headGraph,
    baseGraphPath: baseGraph,
    changeContextFile: join(FIXTURE, "change-context.json"),
    minDensity: 0,
    ...extra,
  });
}

describe("parseChangeContext", () => {
  it("keeps every symbol change with cgraph's status word and the omitted counters verbatim", () => {
    const cc = parseChangeContext(readFileSync(join(FIXTURE, "change-context.json"), "utf8"));
    expect(cc.symbols).toEqual([
      { path: "src/lib.ts", label: "helper", kind: "function", status: "deleted_or_renamed", line: 1 },
      { path: "src/lib.ts", label: "parse", kind: "function", status: "changed", line: 1 },
      { path: "src/lib.ts", label: "emit", kind: "function", status: "added_or_renamed", line: 5 },
    ]);
    expect(cc.omitted).toEqual({ impacts: 2, context: 0 });
    expect(cc.budget).toBe(6000);
    expect(cc.truncated).toBe(true);
  });
});

describe("buildBrief", () => {
  it("lists the commits oldest first with their checkpoint, files and reach", () => {
    const b = brief();
    expect(b.selection.kind).toBe("subset");
    expect(b.baseSha).toBe(base);
    expect(b.headSha).toBe(testCommit);
    expect(b.commits.map((c) => c.sha)).toEqual([libCommit, testCommit]);
    const [lib, test] = b.commits;
    expect(lib).toMatchObject({
      subject: "refactor(lib): inline helper, add emit",
      checkpointId: ID,
      files: ["src/lib.ts"],
      reach: { files: 1, tests: 2 },
      reachingTests: ["src/lib.test.ts", "src/use.test.ts"],
      ranReachingTests: ["src/lib.test.ts"],
    });
    expect(lib?.checkpoint).toMatchObject({
      id: ID,
      agent: "Claude Code",
      model: "claude-sonnet-5",
      prompt: "Remove helper from src/lib.ts and inline it into parse; add emit.",
      filesTouched: ["src/lib.ts", "src/scratch.ts"],
      testCommands: ["bunx vitest run src/lib.test.ts"],
    });
    expect(test).toMatchObject({
      subject: "test(lib): cover emit",
      files: ["src/lib.test.ts"],
      reach: { files: 0, tests: 1 },
      reachingTests: ["src/lib.test.ts"],
      ranReachingTests: [],
    });
    expect(test?.checkpointId).toBeUndefined();
    expect(test?.checkpoint).toBeUndefined();
  });

  it("takes a checkpoint-less commit's intent from the fleet session index when sessionsDb is given", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "blastline-brief-local-")), "sessions.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table sessions (id text primary key, agent text, model text, cwd text, timestamp text, last_activity text,
                             ticket_id text, pr_number integer, first_user_message text, recent_directories_touched text);
      create table session_timelines (session_id text primary key, state_json text);
      create table tool_calls (call_key text primary key, session_id text, timestamp text, tool text, input text);
      create virtual table tool_call_text using fts5(call_key, tool, input, output, error);
      create virtual table session_text using fts5(session_id, label, topic, project, content, assistant);
    `);
    const at = execFileSync("git", ["-C", repo, "log", "-1", "--format=%cI", testCommit], { encoding: "utf8" }).trim();
    const t = new Date(at).getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    db.prepare(`insert into sessions values (?,?,?,?,?,?,?,?,?,?)`).run("11111111-local", "codex", "gpt-6-astra", repo, iso(t - 3_600_000), iso(t + 3_600_000), "CGR-9", null, "cover emit with a test", null);
    db.prepare(`insert into session_timelines values (?,?)`).run("11111111-local", JSON.stringify({ version: 1, steps: [{ text: "Adding the emit test and running the lib suite.", at: iso(t - 60_000), endedAt: iso(t + 60_000), source: "narration", tools: 3, mix: { test: 1, edit: 1 } }] }));
    db.prepare(`insert into tool_calls values (?,?,?,?,?)`).run("l1", "11111111-local", iso(t - 30_000), "exec", JSON.stringify({ input: 'text(await tools.exec_command({cmd:"bunx vitest run src/lib.test.ts"}))' }));
    db.close();
    const b = brief({ sessionsDb: dbPath });
    const [lib, test] = b.commits;
    expect(lib?.checkpoint?.source).toBe("entire");
    expect(test?.checkpointId).toBeUndefined();
    expect(test?.checkpoint).toMatchObject({ id: "", agent: "codex", model: "gpt-6-astra", source: "sessions.db", prompt: "Adding the emit test and running the lib suite.", filesTouched: ["src/lib.test.ts"], testCommands: ["bunx vitest run src/lib.test.ts"] });
    expect(test?.ranReachingTests).toEqual(["src/lib.test.ts"]);
    expect(brief().commits[1]?.checkpoint).toBeUndefined();
  });

  it("attributes a checkpoint-less commit by its Copilot trailer, and names the sources it lacked otherwise", () => {
    write("GUIDE.md", "# guide\n");
    git("add", "-A");
    git("commit", "-q", "-m", "docs: guide\n\nAgent-Logs-Url: https://github.com/o/r/sessions/01ABC");
    const sha = git("rev-parse", "HEAD");
    const b = brief({ range: `${testCommit}..${sha}` });
    expect(b.commits).toHaveLength(1);
    expect(b.commits[0]).toMatchObject({ sha, provenance: { agent: "copilot", via: "Agent-Logs-Url", logsUrl: "https://github.com/o/r/sessions/01ABC" } });
    expect(b.commits[0]?.checkpoint).toBeUndefined();
    expect(b.claims.filter((c) => c.claim.includes(sha.slice(0, 7)))).toEqual([]);
    expect(b.unchecked.some((u) => u.startsWith("intent for"))).toBe(false);
    expect(brief().unchecked).toContain(
      "intent for 1 commit: no `Entire-Checkpoint` or `Agent-Logs-Url` trailer, no vendor address as author or co-author, and no session index (`--local`) on this machine",
    );
    git("commit", "-q", "--allow-empty", "--author=Claude <noreply@anthropic.com>", "-m", "chore: unpushed ref\n\nEntire-Checkpoint: 01M3AY9296319GSPWRKXGHXQQQ");
    const dangling = git("rev-parse", "HEAD");
    const d = brief({ range: `${sha}..${dangling}` }).commits[0];
    expect(d).toMatchObject({ sha: dangling, checkpointId: "01M3AY9296319GSPWRKXGHXQQQ" });
    expect(d?.checkpoint).toBeUndefined();
    expect(d?.provenance).toBeUndefined();
  });

  it("reads who last changed the changed and reached files up to the base, and keeps only reviews by others", () => {
    const b = brief({ author: "taylorg009", reviews: [{ login: "taylorg009", state: "COMMENTED" }, { login: "tgod009", state: "COMMENTED" }, { login: "tgod009", state: "APPROVED" }] });
    expect(b.review?.author).toBe("taylorg009");
    expect(b.review?.reviews).toEqual([{ login: "tgod009", state: "APPROVED" }]);
    expect(b.review?.owners.files).toBeGreaterThan(0);
    const fixtureAuthor = execFileSync("git", ["-C", repo, "log", "-1", "--format=%an", base], { encoding: "utf8" }).trim();
    expect(b.review?.owners.authors).toEqual([{ name: fixtureAuthor, commits: 1, files: 3 }]);
    expect(b.review?.owners.agentCommits).toBe(0);
    expect(brief().unchecked).toContain("reviewed by: no `--reviews` given, so the row names owners only");
    expect(brief({ author: "taylorg009" }).review?.reviews).toBeUndefined();
    expect(brief({ author: "taylorg009", reviews: [] }).review?.reviews).toEqual([]);
    expect(reviewsIn('[{"user":{"login":"a"},"state":"APPROVED"},{"login":"b","state":"COMMENTED"},{"state":"X"}]')).toEqual([{ login: "a", state: "APPROVED" }, { login: "b", state: "COMMENTED" }]);
  });

  it("names the open PRs whose brief meets this one, and embeds what the next brief needs to meet it", () => {
    const b = brief();
    expect(b.snapshot.changed).toEqual(["src/lib.test.ts", "src/lib.ts"]);
    expect(b.snapshot.symbols).toContain("src/lib.ts:emit");
    expect(b.unchecked).toContain("concurrent PRs: no `--others` given");
    const comment = (snapshot: object): string => `<!-- blastline:test-impact -->\n${SNAPSHOT_MARKER}${JSON.stringify(snapshot)} -->\n### PR brief`;
    const others = [
      { number: 7, body: comment({ head: "7".repeat(40), commits: 1, files: 1, tests: 1, reached: ["src/lib.ts"], changed: ["src/use.ts"], symbols: ["src/use.ts:use"] }) },
      { number: 8, body: comment({ head: "8".repeat(40), commits: 1, files: 1, tests: 0, reached: [], changed: ["src/lib.ts"], symbols: ["src/lib.ts:parse"] }) },
      { number: 9, body: comment({ head: "9".repeat(40), commits: 1, files: 1, tests: 0, reached: ["docs/x.md"], changed: ["README.md"], symbols: [] }) },
      { number: 10, body: comment({ head: "a".repeat(40), commits: 1, files: 1, tests: 0, reached: ["src/lib.ts"] }) },
      { number: 11, body: "no brief here" },
    ];
    const c = brief({ others }).concurrent;
    expect(c).toEqual([
      { number: 7, head: "7".repeat(40), changesReached: [{ path: "src/use.ts", symbols: ["use"] }], reachesChanged: ["src/lib.ts"], bothChange: [] },
      { number: 8, head: "8".repeat(40), changesReached: [], reachesChanged: [], bothChange: ["src/lib.ts"] },
    ]);
    const none = brief({ others: [others[2]!, others[4]!] });
    expect(none.concurrent).toEqual([]);
    expect(none.unchecked).toContain("concurrent PRs: none of the 1 open PR with a brief touches what this PR changes or reaches");
    expect(othersIn('[{"number":3,"body":"x"},{"number":"4","body":"y"},{"body":"z"}]')).toEqual([{ number: 3, body: "x" }]);
    expect(concurrentPrs({ head: "h", commits: 0, files: 0, tests: 0, reached: [] }, others)).toEqual([]);
  });

  it("refutes a removal the base graph still sees callers for, in files the diff did not touch", () => {
    const removed = brief().claims.find((c) => c.claim.startsWith("`helper` removed"));
    expect(removed).toEqual({
      claim: "`helper` removed from `src/lib.ts`",
      verdict: "refuted",
      evidence: "still referenced by `use` (src/use.ts:3), `src/use.ts` in files this diff does not touch",
    });
  });

  it("checks the checkpoint's test run and files touched against the graph and the commit", () => {
    const claims = brief().claims.filter((c) => c.claim.startsWith(`\`${libCommit.slice(0, 7)}\``));
    expect(claims).toEqual([
      {
        claim: `\`${libCommit.slice(0, 7)}\` ran the tests it reaches`,
        verdict: "partial",
        evidence: "ran 1 of 2: src/lib.test.ts; not run: src/use.test.ts",
      },
      {
        claim: `\`${libCommit.slice(0, 7)}\` commits what the agent touched`,
        verdict: "refuted",
        evidence: "touched but not in the commit: src/scratch.ts",
      },
    ]);
    // the human commit has no checkpoint, so it makes no checkpoint claim
    expect(brief().claims.some((c) => c.claim.startsWith(`\`${testCommit.slice(0, 7)}\``))).toBe(false);
  });

  it("still tells changed from unchanged callers when the graph was built below the repository root (bin-v0.5.0 labels)", () => {
    // bin-v0.5.0 labels file nodes relative to the graph root: built with --root src, the
    // file at src/use.ts is labelled "use.ts". The claim check must not compare that to
    // the diff's "src/lib.ts".
    const rooted = JSON.parse(readFileSync(baseGraph, "utf8")) as { nodes: { type?: string; label: string }[] };
    for (const n of rooted.nodes) if (n.type === "file" && n.label.startsWith("src/")) n.label = n.label.slice("src/".length);
    const path = join(repo, "base-graph-rooted.json");
    writeFileSync(path, JSON.stringify(rooted));
    const removed = brief({ baseGraphPath: path }).claims.find((c) => c.claim.startsWith("`helper` removed"));
    expect(removed).toEqual({
      claim: "`helper` removed from `src/lib.ts`",
      verdict: "refuted",
      evidence: "still referenced by `use` (src/use.ts:3), `src/use.ts` in files this diff does not touch",
    });
  });

  it("never prints a certificate", () => {
    const text = JSON.stringify(brief()).toLowerCase();
    expect(text).not.toContain("verified");
    expect(text).not.toContain("safe to");
  });

  it("names a checkpoint it could not read and keeps the brief", () => {
    // Every other test names its range by sha, so one more commit on top is harmless.
    write("src/other.ts", "export function other(): number {\n  return 3;\n}\n");
    const dangling = commitAll("chore: unpushed ref\n\nEntire-Checkpoint: 01M3AY9296319GSPWRKXGHXZZZ\n");
    const b = buildBrief({ repo, range: `${base}..${dangling}`, graphPath: headGraph, minDensity: 0 });
    expect(b.commits.at(-1)).toMatchObject({ sha: dangling, checkpointId: "01M3AY9296319GSPWRKXGHXZZZ" });
    expect(b.commits.at(-1)?.checkpoint).toBeUndefined();
    expect(b.unchecked).toContain(`checkpoint \`01M3AY9296319GSPWRKXGHXZZZ\` for \`${dangling.slice(0, 7)}\`: its ref is not in this repository (push refs/entire/checkpoints/*)`);
  });

  it("names what it could not check instead of staying silent", () => {
    const noContext = buildBrief({ repo, range: `${base}..${testCommit}`, graphPath: headGraph, minDensity: 0 });
    expect(noContext.changeContext).toBeUndefined();
    expect(noContext.unchecked).toContain("symbol changes: no `--change-context` given");
    expect(noContext.claims.some((c) => c.claim.includes("removed"))).toBe(false);
    const noBase = brief({ baseGraphPath: undefined });
    expect(noBase.unchecked).toContain("removed-symbol callers: no `--base-graph` given");
  });

  it("annotates the changed ranges of the highest-reach files first, capped by --annotations", () => {
    const b = brief();
    // src/lib.ts (2 tests, 1 file) outranks src/lib.test.ts (1 test, 0 files)
    expect(b.annotations.map((a) => `${a.path}:${a.start_line}-${a.end_line}`)).toEqual([
      "src/lib.ts:1-2",
      "src/lib.ts:5-6",
      "src/lib.test.ts:1-1",
      "src/lib.test.ts:3-3",
    ]);
    expect(b.annotations[0]).toMatchObject({
      annotation_level: "notice",
      title: "blastline: reach",
      message: "Reaches 1 file and 2 test files through emit, parse.",
    });
    expect(brief({ annotations: 1 }).annotations).toHaveLength(1);
    expect(brief({ annotations: 500 }).annotations.length).toBeLessThanOrEqual(50);
  });

  it("reports the delta since the snapshot embedded in the previous comment", () => {
    const first = buildBrief({ repo, range: `${base}..${libCommit}`, graphPath: headGraph, minDensity: 0 });
    expect(first.snapshot).toMatchObject({ head: libCommit, commits: 1, files: 1, tests: 2, reached: ["src/use.ts"], changed: ["src/lib.ts"] });
    const previous = join(repo, "previous.md");
    writeFileSync(previous, `<!-- blastline:test-impact -->\n${SNAPSHOT_MARKER}${JSON.stringify(first.snapshot)} -->\n### old brief\n`);
    expect(snapshotIn(readFileSync(previous, "utf8"))).toEqual(first.snapshot);
    const second = brief({ previousFile: previous });
    expect(second.sincePrevious).toEqual({ head: libCommit, commits: 1, files: 1, tests: 0, newlyReached: [] });
  });

  it("still lists commits and checks checkpoint claims when the selection fails open", () => {
    const b = buildBrief({ repo, range: `${base}..${testCommit}`, graphPath: "/nope/graph.json", changeContextFile: join(FIXTURE, "change-context.json") });
    expect(b.selection.kind).toBe("all");
    expect(b.commits.map((c) => c.sha)).toEqual([libCommit, testCommit]);
    expect(b.commits[0]?.reach).toEqual({ files: 0, tests: 0 });
    // files touched (refuted); the commit messages name the changed code (consistent); nothing reach-based
    expect(b.claims.map((c) => c.verdict)).toEqual(["refuted", "consistent"]);
    expect(b.annotations).toEqual([]);
    expect(b.snapshot).toMatchObject({ commits: 2, files: 0, tests: 0, reached: [] });
  });
});

describe("commandRuns", () => {
  it("treats a command with no path argument as the whole suite", () => {
    expect(commandRuns("bunx vitest run", "src/a.test.ts")).toBe(true);
    expect(commandRuns("go test ./...", "pkg/a_test.go")).toBe(true);
    expect(commandRuns("bun run test 2>&1 | tail -20", "src/a.test.ts")).toBe(true);
  });

  it("matches named files and directories only", () => {
    expect(commandRuns("bunx vitest run src/a.test.ts", "src/a.test.ts")).toBe(true);
    expect(commandRuns("bunx vitest run src/a.test.ts", "src/b.test.ts")).toBe(false);
    expect(commandRuns("pytest tests/unit", "tests/unit/test_x.py")).toBe(true);
    expect(commandRuns("pytest tests/unit", "tests/e2e/test_x.py")).toBe(false);
    expect(commandRuns("vitest run ./src/a.test.ts --reporter=dot", "src/a.test.ts")).toBe(true);
  });
});

describe("narrative claims", () => {
  it("refutes a name in code font the diff does not carry, and reports a placeholder body", () => {
    const b = brief({ narrative: "Adds retry to `fetchGraph` and touches `src/lib.ts`; see `parse`. Range `main..HEAD`, sha `3ff023b`, flag `--local`, `v0.14.0`." });
    const phantom = b.claims.find((c) => c.claim === "PR body names `fetchGraph`");
    expect(phantom).toEqual({ claim: "PR body names `fetchGraph`", verdict: "refuted", evidence: "no changed symbol bears it and no changed line contains it (phantom change)" });
    expect(b.claims.filter((c) => c.claim.startsWith("PR body names") && c.verdict === "refuted")).toHaveLength(1);
    // a dotted identifier is not a path: its tokens are looked up in the changed lines
    const dotted = brief({ narrative: "Reads `github.event.pull_request.body` and `parse.length`." });
    expect(dotted.claims.filter((c) => c.claim.startsWith("PR body names") && c.verdict === "refuted").map((c) => c.claim)).toEqual(["PR body names `github.event.pull_request.body`"]);
    expect(dotted.claims.find((c) => c.claim === "PR body names `github.event.pull_request.body`")?.evidence).toContain("no changed symbol bears it");
    expect(b.unchecked.some((u) => u.startsWith("narrative:"))).toBe(false);
    expect(brief().unchecked).toContain("narrative: no `--narrative` given, so only commit messages were read");
    expect(brief({ narrative: "" }).claims).toContainEqual({ claim: "PR body describes the change", verdict: "refuted", evidence: "placeholder text: empty" });
    expect(brief({ narrative: "<!-- Describe your changes -->\n" }).claims).toContainEqual({ claim: "PR body describes the change", verdict: "refuted", evidence: "placeholder text: empty" });
    expect(brief({ narrative: "TODO write this" }).claims).toContainEqual({ claim: "PR body describes the change", verdict: "refuted", evidence: 'placeholder text: "TODO"' });
    // a marker inside a real description is prose, not a placeholder
    const prose = brief({ narrative: "Drops the wip check from `parse`; the TODO in `src/lib.ts` is gone. Long enough to be a description of the change." });
    expect(prose.claims.some((c) => c.claim === "PR body describes the change")).toBe(false);
  });

  it("reads a commit's subject, not its body, for a throwaway marker", () => {
    const files = parseUnifiedDiff("diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    const claims = narrativeClaims(
      [
        { source: "commit `aaaaaaa`", text: "wip: parser\n\nnot ready" },
        { source: "commit `bbbbbbb`", text: "fix(brief): a wip or fixup subject is placeholder text\n\nThe word wip in a description is prose." },
        { source: "commit `ccccccc`", text: "fixup! feat(brief): the narrative is a claim\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" },
        { source: "commit `ddddddd`", text: "squash! wire up narrative claims" },
        { source: "commit `eeeeeee`", text: "wipe the cache on start" },
      ],
      files,
      undefined,
      new Set(["src/x.ts"]),
    );
    expect(claims).toEqual([
      { claim: "commit `aaaaaaa` describes the change", verdict: "refuted", evidence: 'placeholder text: "wip"' },
      { claim: "commit `ccccccc` describes the change", verdict: "refuted", evidence: 'placeholder text: "fixup!"' },
      { claim: "commit `ddddddd` describes the change", verdict: "refuted", evidence: 'placeholder text: "squash!"' },
    ]);
  });

  it("calls every named thing consistent when the diff carries it, and never counts a fenced run log", () => {
    const b = brief({ narrative: "Inlines `helper` into `parse` in `src/lib.ts`.\n\n```\n$ bunx vitest run\n Tests  9 passed\nfetchGraph not here\n```\n" });
    expect(b.claims).toContainEqual({ claim: "PR body names 3 things in code font", verdict: "consistent", evidence: "every one is a changed symbol, a changed path, or in a changed line" });
    expect(b.claims.some((c) => c.claim.includes("fetchGraph"))).toBe(false);
    expect(b.claims).toContainEqual({ claim: "the narrative names the changed code", verdict: "consistent", evidence: "all 1 file with symbol changes are named" });
  });

  it("reports understated scope: a file with symbol changes no narrative names", () => {
    const files = parseUnifiedDiff("diff --git a/src/comment.ts b/src/comment.ts\n--- a/src/comment.ts\n+++ b/src/comment.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n");
    const symbols = [
      { path: "src/comment.ts", label: "renderClaims", kind: "function", status: "changed", line: 1 },
      { path: "src/comment.ts", label: "intentRow", kind: "function", status: "changed", line: 9 },
    ];
    const claims = narrativeClaims([{ source: "PR body", text: "Retry the fetch." }, { source: "commit `abc1234`", text: "wip" }], files, symbols, new Set(["src/comment.ts"]));
    expect(claims).toEqual([
      { claim: "commit `abc1234` describes the change", verdict: "refuted", evidence: 'placeholder text: "wip"' },
      { claim: "the narrative names the changed code", verdict: "partial", evidence: "not named by the PR body or any commit message: src/comment.ts (`renderClaims` changed, +1) (understated scope)" },
    ]);
    expect(narrativeClaims([{ source: "PR body", text: "Rework renderClaims." }], files, symbols, new Set(["src/comment.ts"]))).toEqual([
      { claim: "the narrative names the changed code", verdict: "consistent", evidence: "all 1 file with symbol changes are named" },
    ]);
  });

  it("marks a changed declaration partial when the base graph shows callers this diff does not touch", () => {
    const files = parseUnifiedDiff(
      "diff --git a/src/lib.ts b/src/lib.ts\n--- a/src/lib.ts\n+++ b/src/lib.ts\n@@ -5 +5 @@\n-export function parse(input: string): number {\n+export function parse(input: string, strict = false): number {\n",
    );
    const symbols = [{ path: "src/lib.ts", label: "parse", kind: "function", status: "changed", line: 5 }];
    expect(changedDeclarationClaims(symbols, files, loadGraph(baseGraph), new Set(["src/lib.ts"]))).toEqual([
      {
        claim: "`parse` declaration changed in `src/lib.ts`",
        verdict: "partial",
        evidence: "still called by `use` (src/use.ts:3), `src/lib.test.ts`, `src/use.ts` in files this diff does not touch; check those call sites against the new declaration",
      },
    ]);
    // a body-only change (the declaring line untouched) and a declaration whose callers are all in the diff say nothing
    const bodyOnly = parseUnifiedDiff("diff --git a/src/lib.ts b/src/lib.ts\n--- a/src/lib.ts\n+++ b/src/lib.ts\n@@ -6 +6 @@\n-  return 1;\n+  return 2;\n");
    expect(changedDeclarationClaims(symbols, bodyOnly, loadGraph(baseGraph), new Set(["src/lib.ts"]))).toEqual([]);
    expect(changedDeclarationClaims(symbols, files, loadGraph(baseGraph), new Set(["src/lib.ts", "src/use.ts", "src/lib.test.ts"]))).toEqual([]);
  });
});

describe("declares", () => {
  it("recognises declarations across the extracted languages and not call sites", () => {
    expect(declares("parse", "export function parse(input: string): number {")).toBe(true);
    expect(declares("parse", "  async parse<T>(input: T): Promise<number> {")).toBe(true);
    expect(declares("parse", "export const parse = (input: string): number => {")).toBe(true);
    expect(declares("Parser", "export class Parser extends Base {")).toBe(true);
    expect(declares("parse", "def parse(input):")).toBe(true);
    expect(declares("parse", "func (p *Parser) parse(input string) int {")).toBe(true);
    expect(declares("parse", "pub fn parse(input: &str) -> u32 {")).toBe(true);
    expect(declares("parse", "  parse(input);")).toBe(false);
    expect(declares("parse", "  const n = parse(input) + 1;")).toBe(false);
    expect(declares("parse", "export function parseAll(inputs: string[]): number {")).toBe(false);
  });
});
