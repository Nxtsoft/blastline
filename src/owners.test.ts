import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCommit, ownersOf, unfamiliarTo } from "./owners.js";

let repo: string;
let base: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(author: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("-c", `user.name=${author.split(" <")[0]}`, "-c", `user.email=${author.slice(author.indexOf("<") + 1, -1)}`, "commit", "-q", `--author=${author}`, "-m", message);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "blastline-owners-"));
  git("init", "-q");
  commit("Ada <ada@example.com>", "feat: lib", { "src/lib.ts": "export const a = 1;\n", "src/use.ts": "import './lib.js';\n" });
  commit("Ada <ada@example.com>", "fix: lib again", { "src/lib.ts": "export const a = 2;\n" });
  commit("Bo <bo@example.com>", "feat: use", { "src/use.ts": "import './lib.js';\nexport const u = 1;\n" });
  commit("Claude <noreply@anthropic.com>", "chore: agent touched lib", { "src/lib.ts": "export const a = 3;\n" });
  commit("Cy <cy@example.com>", "feat: cloud agent\n\nAgent-Logs-Url: https://github.com/o/r/sessions/1", { "src/lib.ts": "export const a = 4;\n" });
  commit("Di <di@example.com>", "feat: paired\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>", { "src/use.ts": "export const u = 2;\n" });
  commit("Bo <bo@example.com>", "docs: readme", { "README.md": "# r\n" });
  base = git("rev-parse", "HEAD");
  commit("Ada <ada@example.com>", "feat: the range's own commit", { "src/lib.ts": "export const a = 5;\n" });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("ownersOf", () => {
  it("counts human commits per author over the files, most first, and sets agent-authored commits aside", () => {
    expect(ownersOf(repo, base, ["src/lib.ts", "src/use.ts"])).toEqual({
      files: 2,
      commits: 4,
      agentCommits: 2,
      authors: [
        { name: "Ada", commits: 2, files: 2 },
        { name: "Bo", commits: 1, files: 1 },
        { name: "Di", commits: 1, files: 1 },
      ],
      perFile: [
        { path: "src/lib.ts", authors: ["Ada"] },
        { path: "src/use.ts", authors: ["Ada", "Bo", "Di"] },
      ],
    });
  });

  it("names the files none of the given humans has a commit in, and nothing when no human is given", () => {
    const owners = ownersOf(repo, base, ["src/lib.ts", "src/use.ts", "src/new.ts"]);
    expect(unfamiliarTo(owners, new Set(["Bo"]), ["src/lib.ts", "src/use.ts", "src/new.ts"])).toEqual(["src/lib.ts", "src/new.ts"]);
    expect(unfamiliarTo(owners, new Set(["Ada"]), ["src/lib.ts", "src/use.ts"])).toEqual([]);
    expect(unfamiliarTo(owners, new Set(), ["src/lib.ts"])).toEqual([]);
  });

  it("stops at the base, so the range's own commits never count as prior ownership", () => {
    const head = git("rev-parse", "HEAD");
    expect(ownersOf(repo, head, ["src/lib.ts"]).authors[0]).toEqual({ name: "Ada", commits: 3, files: 1 });
    expect(ownersOf(repo, base, ["src/lib.ts"]).authors[0]).toEqual({ name: "Ada", commits: 2, files: 1 });
  });

  it("returns an empty answer for no files, unknown files, or a repository git cannot read", () => {
    expect(ownersOf(repo, base, [])).toEqual({ files: 0, commits: 0, agentCommits: 0, authors: [], perFile: [] });
    expect(ownersOf(repo, base, ["src/nope.ts"])).toEqual({ files: 1, commits: 0, agentCommits: 0, authors: [], perFile: [] });
    expect(ownersOf("/nonexistent", base, ["src/lib.ts"])).toEqual({ files: 1, commits: 0, agentCommits: 0, authors: [], perFile: [] });
  });
});

describe("agentCommit", () => {
  it("recognises a vendor author and Copilot's cloud-agent trailer; a human's commit with an agent co-author or a checkpoint is the human's", () => {
    expect(agentCommit("noreply@anthropic.com", "chore: x")).toBe(true);
    expect(agentCommit("198982749+Copilot@users.noreply.github.com", "chore: x")).toBe(true);
    expect(agentCommit("cy@example.com", "feat: y\n\nAgent-Logs-Url: https://x")).toBe(true);
    expect(agentCommit("cy@example.com", "feat: y\n\nEntire-Checkpoint: 01M3AY9296319GSPWRKXGHXMH5")).toBe(false);
    expect(agentCommit("di@example.com", "feat: z\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>")).toBe(false);
    expect(agentCommit("di@example.com", "feat: z\n\nCo-authored-by: Claude Fable 5.1 <noreply@anthropic.com>")).toBe(false);
    expect(agentCommit("ada@example.com", "feat: mentions Agent-Logs-Url in prose")).toBe(false);
  });
});
