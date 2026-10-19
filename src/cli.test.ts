import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The CLI runs as `node dist/cli.js`, so these tests build once and spawn the
 * built entry point: the checks are about exit codes and what the user sees,
 * which no in-process test can assert.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli.js");
const ENV = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

function run(args: string[], cwd: string): { code: number; out: string; err: string } {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: ENV });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function repoWithCommit(trailer?: string): string {
  const repo = join(mkdtempSync(join(tmpdir(), "blastline-cli-")), "repo");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: ENV }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  g("add", "a.ts");
  g("commit", "-q", "-m", trailer === undefined ? "feat: a" : `feat: a\n\nEntire-Checkpoint: ${trailer}`);
  return repo;
}

beforeAll(() => {
  execFileSync("bunx", ["tsc", "-p", "tsconfig.json"], { cwd: ROOT, env: ENV, stdio: "pipe" });
}, 120_000);

describe("blastline checkpoint write", () => {
  it("fails with a plain message, exit 2, when there is no fleet session index", () => {
    const r = run(["checkpoint", "write", "--sessions-db", "/nonexistent/sessions.db"], repoWithCommit());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^blastline checkpoint: no fleet session index at \/nonexistent\/sessions\.db/);
    expect(r.out).toBe("");
  });

  it("leaves a commit that already carries a trailer alone, and says so as JSON when asked", () => {
    const repo = repoWithCommit("01M3AY9296319GSPWRKXGHXMH5");
    const plain = run(["checkpoint", "write", "--sessions-db", "/nonexistent/sessions.db"], repo);
    expect(plain.code).toBe(0);
    expect(plain.err).toMatch(/already carries Entire-Checkpoint: 01M3AY9296319GSPWRKXGHXMH5/);
    const json = run(["checkpoint", "write", "--json", "--sessions-db", "/nonexistent/sessions.db"], repo);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ id: "01M3AY9296319GSPWRKXGHXMH5", ref: "refs/entire/checkpoints/H5/01M3AY9296319GSPWRKXGHXMH5", commit: "HEAD", trailerWritten: false, written: false });
  });

  it("rejects an unknown checkpoint action with the usage", () => {
    const r = run(["checkpoint", "delete"], repoWithCommit());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown checkpoint action "delete"/);
  });
});

describe("blastline brief --local", () => {
  it("fails with a plain message, exit 2, when the index is missing", () => {
    const repo = repoWithCommit();
    const r = run(["brief", "HEAD~0..HEAD", "--local", "--sessions-db", "/nonexistent/sessions.db"], repo);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^blastline brief: no fleet session index at/);
  });
});

describe("blastline tests --json on a pipe", () => {
  it("prints all of a selection larger than a pipe's 64 KiB buffer", () => {
    // 1,500 of 1,600 test files call the changed function: the selection JSON runs far past 64 KiB.
    const repo = repoWithCommit();
    const tests = Array.from({ length: 1600 }, (_, i) => `tests/case-${String(i).padStart(4, "0")}.test.ts`);
    const graph = {
      nodes: [
        { id: "fn_a", label: "a", type: "function", source_file: join(repo, "a.ts"), source_location: { start_line: 1, end_line: 1 } },
        ...tests.map((t, i) => ({ id: `t${i}`, label: `case${i}`, type: "function", source_file: join(repo, t), source_location: { start_line: 1, end_line: 3 } })),
      ],
      links: tests.slice(0, 1500).map((_, i) => ({ source: `t${i}`, target: "fn_a", relation: "CALLS" })),
    };
    writeFileSync(join(repo, "graph.json"), JSON.stringify(graph));
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    execFileSync("git", ["-C", repo, "commit", "-qam", "feat: a again"], { env: ENV });
    const r = run(["tests", "HEAD~1..HEAD", "--repo", repo, "--graph", join(repo, "graph.json"), "--min-density", "0", "--min-test-reachability", "0", "--max-selected-fraction", "1", "--json"], repo);
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(65_536);
    const selection = JSON.parse(r.out) as { kind: string; tests?: string[] };
    expect(selection.tests).toHaveLength(1500);
  });
});
