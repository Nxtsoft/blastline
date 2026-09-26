import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refFor, ulid, writeCheckpoint } from "./checkpoint-write.js";
import { checkpointFor } from "./checkpoint.js";
import type { CommitIntent } from "./sessions.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

function repo(): { repo: string; sha: string; g: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "blastline-checkpoint-"));
  const r = join(dir, "repo");
  const g = (...args: string[]) => execFileSync("git", ["-C", r, ...args], { encoding: "utf8", env: ENV }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  writeFileSync(join(r, "src.ts"), "export const a = 1;\n");
  g("add", "src.ts");
  g("commit", "-q", "-m", "feat: first");
  writeFileSync(join(r, "src.ts"), "export const a = 2;\n");
  writeFileSync(join(r, "src.test.ts"), "// test\n");
  g("add", "src.ts", "src.test.ts");
  g("commit", "-q", "-m", "fix: bump a");
  return { repo: r, sha: g("rev-parse", "HEAD"), g };
}

const intent = (sha: string): CommitIntent => ({
  commit: sha,
  committedAt: "2026-09-24T16:23:46.000Z",
  session: { id: "7182303c-7ae6-4e9a-a0f3-fb7230b71749", agent: "claude", model: "claude-fable-5-1", cwd: "/x", startedAt: "2026-09-24T06:21:20.202Z", lastActivity: "2026-09-24T22:45:22.485Z", prNumber: 31 },
  step: { text: "Three things in parallel now: confirm the follow-up commit state.", at: "2026-09-24T16:23:42.000Z", endedAt: "2026-09-24T16:24:41.000Z", source: "narration", covering: true, mix: { git: 1, test: 1 } },
  testCommands: ["NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts"],
});

describe("ulid", () => {
  it("is 26 Crockford base32 chars, time-ordered, and shards on its last two chars like Entire", () => {
    const a = ulid(new Date("2026-09-25T00:08:41Z"));
    const b = ulid(new Date("2026-09-25T00:08:42Z"));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(refFor("01M3AY9296319GSPWRKXGHXMH5")).toBe("refs/entire/checkpoints/H5/01M3AY9296319GSPWRKXGHXMH5");
  });
});

describe("writeCheckpoint read back by checkpointFor", () => {
  it("reads each commit's own transcript whole: two commits of one session do not read as one step", () => {
    const { repo: r, sha: first, g } = repo();
    const one = writeCheckpoint(r, first, { ...intent(first), testCommands: ["bunx vitest run a.test.ts", "bunx vitest run b.test.ts"] }, { version: "0.15.0", trailer: true });
    writeFileSync(join(r, "src.ts"), "export const a = 3;\n");
    g("add", "src.ts");
    g("commit", "-q", "-m", "fix: again");
    const second = g("rev-parse", "HEAD");
    const two = writeCheckpoint(r, second, { ...intent(second), testCommands: ["bunx vitest run c.test.ts"] }, { version: "0.15.0", trailer: true });
    const cp1 = checkpointFor(r, one.commit, [], new Map(), ["src.ts"]);
    expect(cp1?.testCommands).toEqual(["bunx vitest run a.test.ts", "bunx vitest run b.test.ts"]);
    const read = new Map(cp1!.sessions.map((s) => [s.id, { sha: one.commit, lines: s.lines, hash: s.hash }]));
    const cp2 = checkpointFor(r, two.commit, [], read, ["src.ts"]);
    expect(cp2?.testCommands).toEqual(["bunx vitest run c.test.ts"]);
    expect(cp2?.sameStepAs).toBeUndefined();
    expect(cp2?.narration.started).toBe("");
    expect(cp2?.prompt).toBe("Three things in parallel now: confirm the follow-up commit state.");
  });
});

describe("writeCheckpoint", () => {
  it("writes the six-path Entire tree under the sharded ref and amends HEAD with the trailer", () => {
    const { repo: r, sha, g } = repo();
    const out = writeCheckpoint(r, sha, intent(sha), { version: "0.13.0", trailer: true });
    expect(out.trailerWritten).toBe(true);
    expect(out.commit).not.toBe(sha);
    expect(g("rev-parse", "HEAD")).toBe(out.commit);
    expect(g("log", "-1", "--format=%B")).toContain(`Entire-Checkpoint: ${out.id}`);
    expect(g("ls-tree", "-r", "--name-only", out.ref).split("\n")).toEqual([
      "0/content_hash.txt",
      "0/metadata.json",
      "0/prompt.txt",
      "0/transcript.jsonl",
      "metadata.json",
    ]);
    const meta = JSON.parse(g("show", `${out.ref}:metadata.json`));
    expect(meta).toMatchObject({ checkpoint_id: out.id, source: "blastline", strategy: "manual-commit", branch: "main", files_touched: ["src.test.ts", "src.ts"], ticket_id: null });
    expect(meta.sessions[0]).toMatchObject({ prompt: "/0/prompt.txt", compact_transcript: "/0/transcript.jsonl" });
    expect(JSON.parse(g("show", `${out.ref}:0/metadata.json`))).toMatchObject({ session_id: "7182303c-7ae6-4e9a-a0f3-fb7230b71749", agent: "claude", model: "claude-fable-5-1", turn_id: "2026-09-24T16:23:42.000Z", step_covers_commit: true });
    expect(g("show", `${out.ref}:0/prompt.txt`)).toBe("Three things in parallel now: confirm the follow-up commit state.");
    const record = JSON.parse(g("show", `${out.ref}:0/transcript.jsonl`));
    expect(record.content[0]).toEqual({ type: "tool_use", name: "Bash", input: { command: "NODE_DISABLE_COMPILE_CACHE=1 bunx vitest run src/figure.test.ts" } });
    const transcriptBytes = execFileSync("git", ["-C", r, "cat-file", "blob", `${out.ref}:0/transcript.jsonl`]);
    const hashBytes = execFileSync("git", ["-C", r, "cat-file", "blob", `${out.ref}:0/content_hash.txt`]);
    expect(hashBytes.toString()).toBe(`sha256:${createHash("sha256").update(transcriptBytes).digest("hex")}`);
    expect(hashBytes.length).toBe(71);
  });

  it("signs the checkpoint commit with a fixed identity when git has none, and with the repo's when it has one", () => {
    const { repo: r, sha, g } = repo();
    const bare = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } as NodeJS.ProcessEnv;
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete bare[k];
    const anon = writeCheckpoint(r, sha, intent(sha), { version: "0.13.0", trailer: true, env: bare });
    expect(g("log", "-1", "--format=%ae %ce", anon.ref)).toBe("blastline@checkpoint blastline@checkpoint");
    expect(g("log", "-1", "--format=%ce", "HEAD")).toBe("blastline@checkpoint");
    g("config", "user.email", "dev@example.test");
    g("config", "user.name", "dev");
    const named = writeCheckpoint(r, g("rev-parse", "HEAD"), intent(sha), { version: "0.13.0", env: bare });
    expect(g("log", "-1", "--format=%ae", named.ref)).toBe("dev@example.test");
  });

  it("lists a merge commit's combined files instead of nothing", () => {
    const { repo: r, g } = repo();
    g("checkout", "-q", "-b", "side", "HEAD~1");
    writeFileSync(join(r, "side.ts"), "export const s = 1;\n");
    g("add", "side.ts");
    g("commit", "-q", "-m", "feat: side");
    g("checkout", "-q", "main");
    g("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = g("rev-parse", "HEAD");
    expect(g("rev-list", "--parents", "-1", merge).split(" ")).toHaveLength(3);
    const out = writeCheckpoint(r, merge, undefined, { version: "0.13.0" });
    expect(JSON.parse(g("show", `${out.ref}:metadata.json`)).files_touched).toEqual(["side.ts"]);
  });

  it("writes the ref but leaves the commit alone when it is already on a remote or is not HEAD", () => {
    const { repo: r, sha, g } = repo();
    const bare = mkdtempSync(join(tmpdir(), "blastline-remote-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    g("remote", "add", "origin", bare);
    g("push", "-q", "origin", "main");
    const pushed = writeCheckpoint(r, sha, intent(sha), { version: "0.13.0", trailer: true });
    expect(pushed.trailerWritten).toBe(false);
    expect(g("rev-parse", "HEAD")).toBe(sha);
    expect(g("rev-parse", pushed.ref)).toMatch(/^[0-9a-f]{40}$/);

    const first = g("rev-parse", "HEAD~1");
    const older = writeCheckpoint(r, first, undefined, { version: "0.13.0", trailer: true });
    expect(older.trailerWritten).toBe(false);
    expect(older.commit).toBe(first);
    expect(JSON.parse(g("show", `${older.ref}:metadata.json`)).files_touched).toEqual(["src.ts"]);
    expect(JSON.parse(g("show", `${older.ref}:0/metadata.json`))).toMatchObject({ session_id: null, agent: "unknown", step_covers_commit: false });
    expect(g("show", `${older.ref}:0/prompt.txt`)).toBe("");
  });
});
