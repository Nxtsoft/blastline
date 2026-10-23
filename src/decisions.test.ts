import { describe, expect, it } from "vitest";
import { chooseDecisions, code, decisionsIn, verificationStatus, withLogOutputs } from "./decisions.js";

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
    expect(texts(window(ran("npx jest 2>&1 | tail -3", "Tests:       1 failed, 4 passed, 5 total")))).toEqual(["tests: `jest` (whole suite) failed on its last run"]);
    expect(texts(window(ran("uv run pytest -q | tail -1", "==== 2 failed, 9 passed in 1.20s ====")))).toEqual(["tests: `pytest` (whole suite) failed on its last run"]);
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

  it("calls a failure fixed when a later run of the runner covers its files: the whole suite, or a folder holding them", () => {
    const fail = ran("bunx vitest run src/cap/cap.test.ts | tail -1", "Tests  1 failed (1)");
    const fixed = ["tests: `vitest` on `src/cap/cap.test.ts` failed, then passed"];
    expect(texts(window(fail, ran("bunx vitest run | tail -1", "Tests  40 passed (40)")), ["src/cap/cap.test.ts"])).toEqual(fixed);
    expect(texts(window(fail, ran("bunx vitest run src/cap src/other 2>&1 | tail -1", "Tests  12 passed (12)")), ["src/cap/cap.test.ts"])).toEqual(fixed);
  });

  it("calls nothing fixed by a pass a filter, a project, a config or a bare name narrowed", () => {
    const fail = ran("bunx vitest run src/cap/cap.test.ts | tail -1", "Tests  1 failed (1)");
    for (const narrowed of ['bunx vitest run -t "rounds up"', "bunx vitest run other", "bunx vitest run --project e2e", "bunx vitest run --testNamePattern=other", "bunx vitest run tests", "bunx vitest run --config vitest.e2e.config.ts src/cap"]) {
      expect(texts(window(fail, ran(`${narrowed} 2>&1 | tail -1`, "Tests  9 passed (9)")), ["src/cap/cap.test.ts"]), narrowed).toEqual([]);
    }
    // The same for pytest's -k and go's -run: the failure is closed by nothing, and not called the last word either.
    expect(texts(window(ran("uv run pytest tests/test_cap.py | tail -1", "==== 1 failed in 0.10s ===="), ran("uv run pytest -k cap | tail -1", "==== 3 passed in 0.10s ====")), ["tests/test_cap.py"])).toEqual([]);
    expect(texts(window(ran("go test ./cap/... | tail -2", "FAIL\tx/cap\t0.1s"), ran("go test -run TestCap ./cap/...", "ok  \tx/cap\t0.1s")), ["cap/cap_test.go"])).toEqual([]);
    // Flags that report, time or schedule do not narrow it.
    expect(texts(window(fail, ran("bunx vitest run --coverage --silent 2>&1 | tail -1", "Tests  40 passed (40)")), ["src/cap/cap.test.ts"])).toEqual(["tests: `vitest` on `src/cap/cap.test.ts` failed, then passed"]);
    expect(texts(window(fail, ran("bunx vitest run --testTimeout=60000 src/cap 2>&1 | tail -1", "Tests  12 passed (12)")), ["src/cap/cap.test.ts"])).toEqual(["tests: `vitest` on `src/cap/cap.test.ts` failed, then passed"]);
  });

  it("calls nothing fixed by a pass from another directory, whose paths name other files", () => {
    const fail = ran("bunx vitest run packages/api/src/index.test.ts | tail -1", "Tests  1 failed (1)");
    expect(texts(window(fail, ran("cd packages/web && bunx vitest run src/index.test.ts | tail -1", "Tests  3 passed (3)")), ["packages/api/src/index.test.ts"])).toEqual([]);
  });

  it("does not call a failure its last run when the runner passed in the same record, in no known order", () => {
    const both = JSON.stringify({
      type: "assistant",
      content: [
        { type: "tool_use", name: "Bash", input: { command: "bunx vitest run src/cap/cap.test.ts | tail -1" }, result: { output: "Tests  1 failed (1)", status: "success" } },
        { type: "tool_use", name: "Bash", input: { command: "bunx vitest run src/other | tail -1" }, result: { output: "Tests  4 passed (4)", status: "success" } },
      ],
    });
    expect(texts(window(both), ["src/cap/cap.test.ts"])).toEqual([]);
  });

  it("does not call a failure the last word when the runner passed after it on other files, nor call it fixed", () => {
    expect(texts(window(ran("bunx vitest run src/cap/cap.test.ts | tail -1", "Tests  1 failed (1)"), ran("bunx vitest run src/other 2>&1 | tail -1", "Tests  9 passed (9)")), ["src/cap/cap.test.ts"])).toEqual([]);
  });

  it("never calls a run that exited non-zero a pass, whatever its Tests line says", () => {
    // vitest exits 1 on a file that fails to import or an unhandled error, with every collected test passing.
    const broken = " Test Files  1 failed | 2 passed (3)\n      Tests  4 passed (4)\n     Errors  1 error";
    expect(texts(window(bash("npx vitest run", "error"), ran("npx vitest run", broken, "error")))).toEqual(["tests: `vitest` (whole suite) failed on its last run"]);
    expect(texts(window(ran("npx vitest run 2>&1 | tail -4", broken)))).toEqual(["tests: `vitest` (whole suite) failed on its last run"]);
    expect(texts(window(ran("npx jest 2>&1 | tail -3", "Test Suites: 1 failed, 3 passed, 4 total\nTests:       9 passed, 9 total")))).toEqual(["tests: `jest` (whole suite) failed on its last run"]);
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

describe("decisionsIn: runs read from logs, re-runs, failures outside the change", () => {
  // a web-app PR's shape: two failing files named from a folder run, each fixed and run alone; the whole
  // suite to a log, read later; its failures re-run from a list into another log, read later; the last one alone.
  const change = ["src/a/__tests__/x.test.tsx", "src/b.test.ts", "src/a/x.tsx"];
  const longSession = [
    ran('cd /w && bunx vitest run "src/a/__tests__" "src/b.test.ts" 2>&1 | tail -8', " FAIL  src/b.test.ts > basis > sends it\n FAIL  src/a/__tests__/x.test.tsx > row > cites\n Test Files  2 failed | 10 passed (12)"),
    ran('cd /w && bunx vitest run "src/b.test.ts" 2>&1 | grep -E "Tests  "', "      Tests  55 passed (55)"),
    ran('cd /w && bunx vitest run "src/a/__tests__/x.test.tsx" 2>&1 | grep -E "Tests  "', "      Tests  4 passed (4)"),
    ran('cd /w && bunx vitest run > /tmp/s/full.log 2>&1; echo "DONE full vitest exit=$?"', "DONE full vitest exit=1"),
    ran("cd /api && grep -c pass /tmp/s/api.log", "12"),
    ran('grep -E "Test Files|Tests  " /tmp/s/full.log | tail -2; grep -E "^ FAIL " /tmp/s/full.log | sed "s/ > .*//" | sort -u', " Test Files  2 failed | 600 passed (602)\n      Tests  3 failed | 6000 passed (6003)\n FAIL  src/z/one.test.tsx\n FAIL  src/z/two.test.tsx"),
    ran('cd /w && cat /tmp/s/failed.txt | xargs bunx vitest run > /tmp/s/rerun.log 2>&1; echo "DONE rerun"', "DONE rerun"),
    ran('grep -E "Test Files|Tests  |^ FAIL " /tmp/s/rerun.log', " Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 80 passed (81)\n FAIL  src/z/two.test.tsx > board > drags"),
    ran('cd /w && bunx vitest run "src/z/two.test.tsx" 2>&1 | grep -E "Tests  "', "      Tests  53 passed (53)"),
  ];

  it("reads a redirected run's outcome from the later call that read its log, and closes each failure only with runs of its own files", () => {
    expect(texts(window(...withLogOutputs(longSession)), change)).toEqual([
      "tests: `vitest` on `src/b.test.ts`, `src/a/__tests__/x.test.tsx` failed, then passed",
      "tests: `vitest` (whole suite) failed in 2 files, none in this change, then passed when re-run",
    ]);
  });

  it("reads nothing from a log without the reads: a redirected run alone has no outcome", () => {
    expect(texts(window(longSession[3]!), change)).toEqual([]);
  });

  it("says the commit went in with failures outside the change when nothing ran them again", () => {
    expect(texts(window(...withLogOutputs(longSession.slice(3, 6))), change)).toEqual(["tests: `vitest` (whole suite) failed in 2 files, none in this change"]);
    // A re-run that left one failing, and nothing after it.
    expect(texts(window(...withLogOutputs(longSession.slice(3, 8))), change)).toEqual(["tests: `vitest` (whole suite) failed in 2 files, none in this change; 1 still failed when re-run"]);
  });

  it("does not let an unrelated file's pass close a failure the way one runner name used to", () => {
    // The folder run's two failures, then only a pass of a file outside the change: neither fixed nor the last word.
    expect(texts(window(longSession[0]!, longSession[8]!), change)).toEqual([]);
  });

  it("closes a failure of a run with no cd by a later pass that cds before naming the file, as the shell keeps its directory", () => {
    // a web-app PR: the failing run relied on the shell's directory, the pass that named the file again began with `cd $WT`.
    const fail = ran('sed -n 1p lib/x.ts; bunx vitest run "src/a/view.test.tsx" 2>&1 | tail -3', " FAIL  src/a/view.test.tsx > step 9 > sends no write\n Test Files  1 failed | 12 passed (13)");
    const pass = ran('cd /w && bunx vitest run "src/a/view.test.tsx" "src/b" 2>&1 | tail -2', " Test Files  5 passed (5)\n      Tests  71 passed (71)");
    expect(texts(window(fail, pass), ["lib/x.ts"])).toEqual(["tests: `vitest` failed in 1 file, none in this change, then passed"]);
    // Two different directories never match.
    expect(texts(window(ran('cd /api && bunx vitest run "src/a/view.test.tsx" 2>&1 | tail -3', " FAIL  src/a/view.test.tsx > x\n Test Files  1 failed (1)"), pass), ["lib/x.ts"])).toEqual(["tests: `vitest` failed in 1 file, none in this change"]);
  });

  it("reads no log a later call wrote again before reading it", () => {
    const overwritten = [longSession[3]!, ran("cd /w && bunx vitest run src/b.test.ts > /tmp/s/full.log 2>&1", ""), longSession[5]!];
    expect(withLogOutputs(overwritten)[0]).toBe(overwritten[0]);
  });

  it("says no failing file is outside the change when the list was cut short of the summary's count", () => {
    const cut = ran('bunx vitest run 2>&1 | grep -E "FAIL|Test Files" | head -2', " FAIL  src/z/one.test.tsx\n Test Files  3 failed | 9 passed (12)");
    expect(texts(window(cut), change)).toEqual(["tests: `vitest` (whole suite) failed on its last run"]);
  });

  it("names failing files from a folder's run when the change carries them, from a runner run in a folder of the repo", () => {
    const sub = ran("cd web && npx vitest run src 2>&1 | tail -3", " FAIL  src/b.test.ts > x\n Test Files  1 failed | 4 passed (5)");
    expect(texts(window(sub), ["web/src/b.test.ts"])).toEqual(["tests: `vitest` on `web/src/b.test.ts` failed on its last run"]);
  });
});

describe("decisionsIn: verification notes", () => {
  const verification = (status: string): string => `---\nstatus: ${status}\ntickets: [T-1]\n---\n\n# Verification\n\nWalked on the SECRET host.`;

  it("reports the status a verification note the change carries states, by its repo path", () => {
    expect(texts(window(write("/w/openspec/changes/x/verification.md", verification("PASS"))), ["openspec/changes/x/verification.md"])).toEqual(["verified: openspec/changes/x/verification.md: PASS"]);
  });

  it("keeps the last status of a note written twice, and reads a note written through a heredoc", () => {
    const heredoc = `WT=/w; cat > $WT/openspec/changes/x/verification.md <<'EOF'\n${verification("PASSED")}\nEOF`;
    const d = texts(window(write("/w/openspec/changes/x/verification.md", verification("FAIL")), bash(heredoc, "success")), ["openspec/changes/x/verification.md"]);
    expect(d).toEqual(["verified: openspec/changes/x/verification.md: PASS"]);
  });

  it("says nothing of a note the change does not carry, or of a note that is not a verification", () => {
    expect(texts(window(write("/tmp/s/verification.md", verification("PASS"))), ["openspec/changes/x/verification.md"])).toEqual([]);
    expect(texts(window(write("/w/openspec/changes/x/tasks.md", verification("PASS"))), ["openspec/changes/x/tasks.md"])).toEqual([]);
  });

  it("reads a body status line when there is no front matter, and nothing from prose", () => {
    expect(verificationStatus("# V\n\n**Status:** PARTIAL, the export step was not walked.")).toBe("PARTIAL");
    expect(verificationStatus("# V\n\nThe status of the export is unclear; it may pass.")).toBeUndefined();
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

describe("decisionsIn: review round on 0.25.0", () => {
  const change = ["src/cap.test.ts", "src/cap.ts"];

  it("does not let a narrowed pass that counts as many files close a whole-suite failure: only a list-fed re-run does", () => {
    const fail = ran("npx vitest run 2>&1 | tail -4", " FAIL  src/cap.test.ts > cap\n Test Files  1 failed | 14 passed (15)");
    for (const narrowed of ["npx vitest run -t parser 2>&1 | tail -2", "npx vitest run parser 2>&1 | tail -2"]) {
      expect(texts(window(fail, ran(narrowed, " Test Files  1 passed (1)\n      Tests  3 passed (3)")), change), narrowed).toEqual([]);
    }
    // Fed the failing file from a list, a run that counts exactly that many files and passes is its re-run.
    expect(texts(window(fail, ran("cat /tmp/failed.txt | xargs npx vitest run 2>&1 | tail -2", " Test Files  1 passed (1)\n      Tests  3 passed (3)")), change)).toEqual([
      "tests: `vitest` on `src/cap.test.ts` failed, then passed when re-run",
    ]);
  });

  it("says nothing is outside the change from a pytest list it cannot prove is whole", () => {
    // Twelve tests failed; only one FAILED line is visible after the tail.
    const cut = ran("uv run pytest 2>&1 | tail -3", "FAILED tests/test_other.py::test_x - assert 1 == 2\n==== 12 failed, 40 passed in 3.20s ====");
    expect(texts(window(cut), ["tests/test_cap.py"])).toEqual(["tests: `pytest` (whole suite) failed on its last run"]);
    // Every failing test listed: the files are known, and none is in the change.
    const whole = ran("uv run pytest 2>&1 | tail -4", "FAILED tests/test_other.py::test_x - a\nFAILED tests/test_other.py::test_y - b\n==== 2 failed, 40 passed in 3.20s ====");
    expect(texts(window(whole), ["tests/test_cap.py"])).toEqual(["tests: `pytest` (whole suite) failed in 1 file, none in this change"]);
  });

  it("takes a verification note's status from the note as committed, not from the first time it was written", () => {
    const write2 = (p: string, c: string): string => write(p, c);
    const edit = JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/w/docs/verification.md", old_string: "status: PASS", new_string: "status: FAIL" }, result: { output: "ok", status: "success" } }] });
    const committed = (p: string): string | undefined => (p === "docs/verification.md" ? "---\nstatus: FAIL\n---\n# V" : undefined);
    const d = decisionsIn(window(write2("/w/docs/verification.md", "---\nstatus: PASS\n---\n# V"), edit), ["docs/verification.md"], committed).map((x) => `${x.kind}: ${x.text}`);
    expect(d).toEqual(["verified: docs/verification.md: FAIL"]);
    // A note the session only edited is still one it wrote.
    expect(decisionsIn(window(edit), ["docs/verification.md"], committed).map((x) => x.text)).toEqual(["docs/verification.md: FAIL"]);
    // Not in the commit: no row.
    expect(decisionsIn(window(write2("/w/docs/verification.md", "---\nstatus: PASS\n---")), ["docs/verification.md"], () => undefined)).toEqual([]);
  });

  it("gives no status from a body whose status lines disagree", () => {
    expect(verificationStatus("## Unit\nResult: PASS\n\n## E2E against dev\nResult: FAIL")).toBeUndefined();
    expect(verificationStatus("## Unit\nResult: PASS\n\n## E2E\nResult: PASS")).toBe("PASS");
  });

  it("reads a log only by its whole name, never another log whose name ends the same", () => {
    const lines = [ran("npx vitest run > full.log 2>&1; echo done", "done"), ran("tail -3 web-full.log", " Test Files  3 passed (3)\n      Tests  9 passed (9)")];
    expect(withLogOutputs(lines)[0]).toBe(lines[0]);
  });

  it("resolves a failing path against the run's own directory before naming a changed file", () => {
    const fail = ran("cd packages/b && npx vitest run 2>&1 | tail -3", " FAIL  src/index.test.ts > x\n Test Files  1 failed | 4 passed (5)");
    expect(texts(window(fail), ["packages/a/src/index.test.ts"])).toEqual(["tests: `vitest` (whole suite) failed in 1 file, none in this change"]);
    // Two changed files end the same way and the directory is unknown: neither is named.
    const bare = ran("npx vitest run 2>&1 | tail -3", " FAIL  src/index.test.ts > x\n Test Files  1 failed | 4 passed (5)");
    expect(texts(window(bare), ["packages/a/src/index.test.ts", "packages/b/src/index.test.ts"])).toEqual(["tests: `vitest` (whole suite) failed in 1 file on its last run"]);
  });

  it("never lets runs from two different directories share a target or close each other", () => {
    const web = ran("cd /w/web && npx vitest run 2>&1 | tail -3", " FAIL  src/cap.test.ts > x\n Test Files  1 failed | 4 passed (5)");
    const api = ran("cd /w/api && npx vitest run 2>&1 | tail -2", " Test Files  9 passed (9)\n      Tests  20 passed (20)");
    expect(texts(window(web, api), ["web/src/cap.test.ts"])).toEqual([]);
  });
});
