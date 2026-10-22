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

  it("reads nothing from a red check: the old code written over the files, the run, then the fix copied back in a loop", () => {
    const red = "D=src; for f in a.ts b.ts; do cp \"$D/$f\" /tmp/keep/$f; git show \"origin/dev:$D/$f\" > \"$D/$f\"; done; bunx vitest run src/a.test.ts 2>&1 | head -5; for f in a.ts b.ts; do cp /tmp/keep/$f \"$D/$f\"; done";
    expect(texts(window(ran(red, "Tests  5 failed | 34 passed (39)"), ran("bunx vitest run src/a.test.ts | tail -1", "Tests  39 passed (39)")), ["src/a.test.ts"])).toEqual([]);
  });

  it("still counts a run after a step that only saves an old copy elsewhere, pops a stash, or redirects stderr", () => {
    const fail = ran("bunx vitest run src/a.test.ts | tail -1", "Tests  1 failed (1)");
    for (const after of ["git show HEAD~1:src/a.ts > /tmp/old.ts && bunx vitest run src/a.test.ts | tail -1", "git stash pop && bunx vitest run src/a.test.ts | tail -1", "git show HEAD:src/a.ts 2>/dev/null | head -3; bunx vitest run src/a.test.ts | tail -1"]) {
      expect(texts(window(fail, ran(after, "Tests  1 passed (1)")), ["src/a.test.ts"]), after).toEqual(["tests: `vitest` on `src/a.test.ts` failed, then passed"]);
    }
  });

  it("reads nothing from a run after code is swapped in by a stash or a reversed patch", () => {
    for (const probe of ["git stash && bunx vitest run src/a.test.ts | tail -1", "git apply -R fix.patch && bunx vitest run src/a.test.ts | tail -1"]) {
      expect(texts(window(ran(probe, "Tests  1 failed (1)")), ["src/a.test.ts"]), probe).toEqual([]);
    }
  });

  it("reads nothing from a command that runs the tests twice, or a run that never started", () => {
    expect(texts(window(ran("bunx vitest run a.test.ts | tail -1; git stash; bunx vitest run a.test.ts | tail -1", "Tests  1 passed (1)\nTests  1 failed (1)")))).toEqual([]);
    expect(texts(window(bash("bunx vitest run a.test.ts", "error").replace("SECRET OUTPUT", "Permission to use Bash with command bunx vitest run a.test.ts has been denied.")))).toEqual([]);
  });

  it("does not call a failure the last word when the runner passed after it, on any files", () => {
    expect(texts(window(ran("bunx vitest run src/cap.test.ts | tail -1", "Tests  1 failed (1)"), ran("bunx vitest run | tail -1", "Tests  40 passed (40)")), ["src/cap.test.ts"])).toEqual([]);
  });

  it("never calls a run that exited non-zero a pass, whatever its Tests line says", () => {
    // vitest exits 1 on a file that fails to import or an unhandled error, with every collected test passing.
    const broken = " Test Files  1 failed | 2 passed (3)\n      Tests  4 passed (4)\n     Errors  1 error";
    expect(texts(window(bash("npx vitest run", "error"), ran("npx vitest run", broken, "error")))).toEqual(["tests: `vitest` failed on its last run"]);
    expect(texts(window(ran("npx vitest run 2>&1 | tail -4", broken)))).toEqual(["tests: `vitest` failed on its last run"]);
    expect(texts(window(ran("npx jest 2>&1 | tail -3", "Test Suites: 1 failed, 3 passed, 4 total\nTests:       9 passed, 9 total")))).toEqual(["tests: `jest` failed on its last run"]);
  });

  it("takes no pass from go or cargo lines a pipe may have cut the failing package off", () => {
    expect(texts(window(ran("go test ./... 2>&1 | tail -3", "FAIL\tx/a\t0.1s"), ran("go test ./... 2>&1 | tail -3", "ok  \tx/y\t0.1s\nok  \tx/z\t0.2s")))).toEqual([
      "tests: `go test` failed on its last run",
    ]);
  });

  it("reads a pytest summary in linear time, however long a line of = signs is", () => {
    const started = Date.now();
    expect(texts(window(ran("pytest | tail -1", "= passed in 1s ".repeat(2000))))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("names no config file a flag points at, only test files", () => {
    expect(texts(window(ran("npx vitest run --config vitest.config.ts 2>&1 | tail -3", "Tests  1 failed | 8 passed (9)")), ["vitest.config.ts"])).toEqual(["tests: `vitest` failed on its last run"]);
  });

  it("says nothing about runs that only passed", () => {
    expect(texts(window(bash("npx jest", "success")))).toEqual([]);
  });
});

describe("decisionsIn: questions and reviews", () => {
  const ask = (questions: object[], output: string): string =>
    JSON.stringify({ type: "assistant", content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions }, result: { output, status: "success" } }] });
  const agent = (id: string, input: object, output: string): string =>
    JSON.stringify({ type: "assistant", content: [{ type: "tool_use", id, name: "Agent", input, result: { output, status: "success" } }] });
  const scope = { question: "How should the build go into dev? (SECRET name)", options: [{ label: "Frontend first (Recommended)" }, { label: "Full build" }, { label: "Plan only" }] };

  it("says which option a person picked by position, quoting neither the question nor a label", () => {
    const d = texts(window(ask([scope], 'Your questions have been answered: "How should the build go into dev? (SECRET name)"="Frontend first (Recommended)". You can now continue.')));
    expect(d).toEqual(["asked: you chose the recommended option 1 of 3"]);
    expect(texts(window(ask([scope], '"How should the build go into dev? (SECRET name)"="Full build"')))).toEqual(["asked: you chose option 2 of 3"]);
    expect(texts(window(ask([scope], '"How should the build go into dev? (SECRET name)"="only the API, and call the owner first"')))).toEqual(["asked: you answered in your own words"]);
  });

  it("numbers the questions of one call, and says nothing of one left unanswered", () => {
    const second = { question: "Merge now?", options: [{ label: "Yes" }, { label: "No" }] };
    expect(texts(window(ask([scope, second], '"Merge now?"="No"')))).toEqual(["asked: question 2 of 2: you chose option 2 of 2"]);
  });

  it("reads a reviewer's verdict from its fixed words, in its result or in the notification it sends later", () => {
    const now = agent("toolu_r1", { subagent_type: "code-reviewer", description: "Review PR 7" }, "Verdict: CHANGES REQUESTED. The matcher drops aliases (SECRET).");
    const later = agent("toolu_r2", { subagent_type: "general-purpose", description: "Review PR 7 as a non-author" }, "Async agent launched successfully.");
    const note = person("<task-notification>\n<tool-use-id>toolu_r2</tool-use-id>\n<result>**APPROVE.** Nothing blocking.</result>\n</task-notification>");
    const silent = agent("toolu_r3", { subagent_type: "artifact-critic", description: "critic" }, "Looks fine to me.");
    expect(texts(window(now, later, note, silent))).toEqual([
      "reviewed: `code-reviewer`: changes requested",
      "reviewed: `general-purpose`: approved",
      "reviewed: `artifact-critic`: verdict not recorded",
    ]);
  });

  it("reads a verdict only where a reviewer states one, so a sentence that says not APPROVED is not an approval", () => {
    const r = (out: string): string[] => texts(window(agent("toolu_v", { subagent_type: "code-reviewer", description: "Review PR 7" }, out)));
    expect(r("The PR is not APPROVED yet; two blockers remain.")).toEqual(["reviewed: `code-reviewer`: verdict not recorded"]);
    expect(r("I cannot APPROVE this.")).toEqual(["reviewed: `code-reviewer`: verdict not recorded"]);
    expect(r("Verdict: BLOCKED. Do not APPROVE until the race is fixed.")).toEqual(["reviewed: `code-reviewer`: changes requested"]);
    expect(r("Notes first.\n\n## Verdict\nREADY TO MERGE")).toEqual(["reviewed: `code-reviewer`: approved"]);
    expect(r("**APPROVE.** Nothing blocking.")).toEqual(["reviewed: `code-reviewer`: approved"]);
    expect(r("Verdict: not APPROVED yet")).toEqual(["reviewed: `code-reviewer`: verdict not recorded"]);
  });

  it("is not a review when only a word like critical or preview is in the description", () => {
    expect(texts(window(agent("toolu_c", { subagent_type: "general-purpose", description: "Fix critical upload bug" }, "Done, tests APPROVED by CI")))).toEqual([]);
    expect(texts(window(agent("toolu_p", { subagent_type: "general-purpose", description: "Build preview deploy" }, "")))).toEqual([]);
  });

  it("says which options a person ticked on a multi-select question, and no position when two labels are alike", () => {
    const multi = { question: "Which checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }] };
    expect(texts(window(ask([multi], '"Which checks?"="Lint, Tests"')))).toEqual(["asked: you chose options 1, 3 of 3"]);
    const twins = { question: "Which?", options: [{ label: "Same" }, { label: "Same" }] };
    expect(texts(window(ask([twins], '"Which?"="Same"')))).toEqual(["asked: you answered in your own words"]);
  });

  it("is not a review when the subagent explores or builds", () => {
    expect(texts(window(agent("toolu_e", { subagent_type: "Explore", description: "Map the step code" }, "APPROVE")))).toEqual([]);
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
