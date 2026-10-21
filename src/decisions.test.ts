import { describe, expect, it } from "vitest";
import { chooseDecisions, code, decisionsIn } from "./decisions.js";

// Records in the compact transcript's shape (Entire transcript format v1): tool results inlined into the tool_use.
const person = (...texts: string[]): string => JSON.stringify({ type: "user", content: texts.map((text) => ({ text })) });
const said = (text: string): string => JSON.stringify({ type: "assistant", content: [{ type: "text", text }] });
const bash = (command: string, status: "success" | "error", description = ""): string =>
  JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command, description }, result: { output: "SECRET OUTPUT", status } }] });
const ran = (command: string, output: string, status: "success" | "error" = "success"): string =>
  JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command }, result: { output, status } }] });
const write = (file_path: string, content: string): string => JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path, content }, result: { output: "ok", status: "success" } }] });
const window = (...records: string[]): string => records.join("\n");
const texts = (window: string, files: string[] = []): string[] => decisionsIn(window, files).map((d) => `${d.kind}: ${d.text}`);

describe("decisionsIn: free text", () => {
  it("quotes nothing a person typed or the agent wrote, however it is worded", () => {
    expect(
      texts(window(person("no, use the router-driven key instead"), said("I kept warn instead of stop because steps 4 and 9 share it."), said("The root cause is /home/t/x because the key sk-ant-api03-XXXX expired."))),
    ).toEqual([]);
  });
});

describe("decisionsIn: tests", () => {
  it("names the runner and the test files the change carries, never the command", () => {
    const d = texts(
      window(bash("cd web && GITHUB_TOKEN=ghp_abcdef123456 bunx vitest run src/cap.test.ts 2>&1", "error"), bash("bunx vitest run src/cap.test.ts", "success")),
      ["src/cap.test.ts"],
    );
    expect(d).toEqual(["tests: `vitest` on `src/cap.test.ts` failed, then passed"]);
  });

  it("names only the runner when the command's files are not in the change, and never a path or a credential", () => {
    const d = texts(window(bash("pytest --db postgres://user:pass@db.example.com/x /Users/t/app/tests/test_cap.py", "error")));
    expect(d).toEqual(["tests: `pytest` failed on its last run"]);
  });

  it("reads no status from a script or a chain whose last step is not the run", () => {
    expect(texts(window(bash("bun build x.ts && echo ok || bun test evals/n.test.ts 2>&1 | tail -3", "error")))).toEqual([]);
    expect(texts(window(bash("python3 - <<'EOF'\nprint(1)\nEOF\nbunx vitest run", "error")))).toEqual([]);
    expect(texts(window(bash("bunx vitest run a.test.ts && git push", "error")))).toEqual([]);
  });

  it("reads no status from a piped run: the status is the last pipe's", () => {
    // grep exits 1 when a passing run prints no FAIL; tail exits 0 after a failing one.
    expect(texts(window(bash("bunx vitest run src/cap.test.ts | grep FAIL", "error"), bash("bunx vitest run 2>&1 | tail -5", "error")), ["src/cap.test.ts"])).toEqual([]);
  });

  it("counts a run only with the runner in command position", () => {
    expect(texts(window(bash("ls node_modules/.bin/vitest", "error"), bash('echo "=== vitest ==="', "error"), bash("rg -n jest src/", "error")))).toEqual([]);
  });

  it("names two test files and counts the rest, so the outcome is always said", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/feature/deeply/nested/module${i}.test.ts`);
    expect(texts(window(bash(`bunx vitest run ${files.join(" ")}`, "error")), files)).toEqual([
      "tests: `vitest` on `src/feature/deeply/nested/module0.test.ts`, `src/feature/deeply/nested/module1.test.ts` and 10 more failed on its last run",
    ]);
  });

  it("reads a piped run's outcome from the runner's own summary, whatever the pipe exits", () => {
    const d = texts(
      window(
        ran("bunx vitest run src/cap.test.ts 2>&1 | grep -E 'Tests|FAIL' | head", "      Tests  1 failed | 2 passed (3)"),
        ran("cd /w/app && bunx vitest run src/cap.test.ts 2>&1 | tail -5; git status --short", " Test Files  1 passed (1)\n      Tests  3 passed (3)"),
      ),
      ["src/cap.test.ts"],
    );
    expect(d).toEqual(["tests: `vitest` on `src/cap.test.ts` failed, then passed"]);
    // jest, pytest and go print their own summaries.
    expect(texts(window(ran("npx jest 2>&1 | tail -3", "Tests:       1 failed, 4 passed, 5 total")))).toEqual(["tests: `jest` failed on its last run"]);
    expect(texts(window(ran("uv run pytest -q | tail -1", "==== 2 failed, 9 passed in 1.20s ====")))).toEqual(["tests: `pytest` failed on its last run"]);
    expect(texts(window(ran("go test ./... | tail -4", "ok  \tx/a\t0.1s\nFAIL\tx/b\t0.2s")))).toEqual(["tests: `go test` failed on its last run"]);
  });

  it("names the files a variable holds, when the command assigns it", () => {
    const d = texts(window(ran('T="src/cap.test.ts"; bunx vitest run "$T" 2>&1 | tail -2', "Tests  1 failed (1)")), ["src/cap.test.ts"]);
    expect(d).toEqual(["tests: `vitest` on `src/cap.test.ts` failed on its last run"]);
  });

  it("names no file when the run also covers a folder or a file the change does not carry", () => {
    expect(texts(window(ran("bunx vitest run src/cap.test.ts src/other/ 2>&1 | tail -2", "Tests  1 failed | 9 passed (10)")), ["src/cap.test.ts"])).toEqual([
      "tests: `vitest` failed on its last run",
    ]);
  });

  it("reads nothing from a probe: a run against swapped-in code that is put back after", () => {
    const probe = 'cp src/cap.ts /tmp/cap.bak && git show origin/dev:src/cap.ts > src/cap.ts && bunx vitest run src/cap.test.ts 2>&1 | tail -2; cp /tmp/cap.bak src/cap.ts';
    expect(texts(window(ran("bunx vitest run src/cap.test.ts | tail -1", "Tests  3 passed (3)"), ran(probe, "Tests  2 failed | 1 passed (3)")), ["src/cap.test.ts"])).toEqual([]);
  });

  it("reads nothing from a command that runs the tests twice, or a run that never started", () => {
    expect(texts(window(ran("bunx vitest run a.test.ts | tail -1; git stash; bunx vitest run a.test.ts | tail -1", "Tests  1 passed (1)\nTests  1 failed (1)")))).toEqual([]);
    expect(texts(window(bash("bunx vitest run a.test.ts", "error").replace("SECRET OUTPUT", "Permission to use Bash with command bunx vitest run a.test.ts has been denied.")))).toEqual([]);
  });

  it("does not call a failure the last word when the runner passed after it, on any files", () => {
    expect(texts(window(ran("bunx vitest run src/cap.test.ts | tail -1", "Tests  1 failed (1)"), ran("bunx vitest run | tail -1", "Tests  40 passed (40)")), ["src/cap.test.ts"])).toEqual([]);
  });

  it("says nothing about runs that only passed", () => {
    expect(texts(window(bash("npx jest", "success")))).toEqual([]);
  });
});

describe("decisionsIn: reverts and design notes", () => {
  it("reports a revert by a fixed label, never its description", () => {
    expect(
      texts(
        window(
          bash("git revert --no-edit HEAD", "success", "Revert the bot's autofix for acme"),
          bash('git checkout HEAD -- "/Users/t/wt/src/a.ts"', "success"),
          bash("git reset --hard origin/x", "success", "Reset /home/t/wt to the remote"),
        ),
      ),
    ).toEqual(["reverted: git revert", "reverted: git checkout --", "reverted: git reset --hard"]);
  });

  it("is not an unstage or an amend", () => {
    expect(texts(window(bash("git restore --staged src/a.ts", "success"), bash('git commit --author "T <t@example.com>" --amend --no-edit', "success", "Fix the author")))).toEqual([]);
  });

  it("reports design notes that weigh alternatives only when the change carries them, by their repo path", () => {
    const notes = "# Design\n\n## Alternatives considered\n\nA cache per tenant.";
    const d = decisionsIn(window(write("/Users/t/wt/openspec/changes/cap/design.md", notes), write("/Users/t/notes/scratch.md", notes)), ["openspec/changes/cap/design.md"]);
    expect(d).toEqual([{ kind: "alternatives", text: "openspec/changes/cap/design.md", at: 0 }]);
  });
});

describe("code", () => {
  it("keeps a backtick inside code font, so nothing after it becomes a mention", () => {
    expect(code("docs/a.md")).toBe("`docs/a.md`");
    expect(code("docs/a`@octocat`.md")).toBe("`` docs/a`@octocat`.md ``");
  });
});

describe("chooseDecisions", () => {
  it("keeps test outcomes and reverts over design notes, in session order", () => {
    const all = [
      { kind: "alternatives" as const, text: "a" },
      { kind: "alternatives" as const, text: "b" },
      { kind: "reverted" as const, text: "c" },
      { kind: "tests" as const, text: "d" },
      { kind: "alternatives" as const, text: "e" },
    ];
    expect(chooseDecisions(all, 3).map((d) => d.text)).toEqual(["a", "c", "d"]);
    expect(chooseDecisions(all, 9)).toBe(all);
  });
});
