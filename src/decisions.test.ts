import { describe, expect, it } from "vitest";
import { cap, chooseDecisions, decisionsIn, findingIn, shareable } from "./decisions.js";

// Records in the compact transcript's shape (Entire transcript format v1): tool results inlined into the tool_use.
const person = (...texts: string[]): string => JSON.stringify({ type: "user", content: texts.map((text) => ({ text })) });
const said = (text: string): string => JSON.stringify({ type: "assistant", content: [{ type: "text", text }] });
const bash = (command: string, status: "success" | "error", description = ""): string =>
  JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command, description }, result: { output: "SECRET OUTPUT", status } }] });
const write = (file_path: string, content: string): string => JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path, content }, result: { output: "ok", status: "success" } }] });
const window = (...records: string[]): string => records.join("\n");
const texts = (window: string, files: string[] = [], opensTurn = true): string[] => decisionsIn(window, files, opensTurn).map((d) => `${d.kind}: ${d.text}`);

describe("decisionsIn: what a person said", () => {
  it("leaves the opening request to the Intent column, skips a go-ahead, and calls a later instruction steering", () => {
    expect(texts(window(person("move the round-size cap into one module"), said("On it."), person("sounds good let's do it"), person("keep the old export for the eval harness")))).toEqual([
      "steered: keep the old export for the eval harness",
    ]);
  });

  it("calls the first thing a person says steering when the window continues a turn", () => {
    expect(texts(window(said("Done with the cap."), person("use the router-driven key instead")), [], false)).toEqual(["steered: use the router-driven key instead"]);
  });

  it("reads a person's words past a block the harness put first in the same record", () => {
    expect(texts(window(person("<system-reminder>ctx</system-reminder>", "no, use the router-driven key instead")), [], false)).toEqual(["steered: no, use the router-driven key instead"]);
  });

  it("drops operating instructions: git authors, staging, merges, other PRs", () => {
    expect(texts(window(person("you used the wrong git author since vercel failed"), person("move BUG-82 to staging"), person("fix the author on #742")), [], false)).toEqual([]);
  });
});

describe("findingIn: what the agent found or chose", () => {
  it("takes the first sentence that gives a reason or an alternative, with a reason that follows it", () => {
    expect(findingIn("Read the three call sites. I kept warn instead of stop, so the same calculation behaves the same on every step. Pushing now.")).toBe(
      "I kept warn instead of stop, so the same calculation behaves the same on every step.",
    );
    expect(findingIn("- **Root cause:** the cache key ignores the tenant, so two tenants share one entry.")).toBe("Root cause: the cache key ignores the tenant, so two tenants share one entry.");
    expect(findingIn("I went with option B for the cache key. Because it keeps tenants apart.")).toBe("I went with option B for the cache key. Because it keeps tenants apart.");
  });

  it("keeps a bold lead-in with the sentence it labels, not the label alone", () => {
    expect(
      findingIn("- **One more issue the subagent found, not filed.** Every save after step 9 silently dropped 2 constraints from the draft. Want me to file it?"),
    ).toBe("One more issue the subagent found, not filed. Every save after step 9 silently dropped 2 constraints from the draft.");
  });

  it("skips progress chatter, a bare 'found X', clean tool output, operations, quotes and fenced code", () => {
    expect(findingIn("Still waiting on CI because the runner is slow today.")).toBeUndefined();
    expect(findingIn("Found the step 4 import sites.")).toBeUndefined();
    expect(findingIn("Typecheck printed no errors and ESLint found 0 errors.")).toBeUndefined();
    expect(findingIn("E2E failed on a docs-only PR, which points to a problem that was already there rather than this change.")).toBeUndefined();
    expect(findingIn("> Error: the cache broke because the file is missing")).toBeUndefined();
    expect(findingIn("```\nthe root cause is in here because reasons\n```")).toBeUndefined();
  });
});

describe("decisionsIn: tests", () => {
  it("names the runner and the test files the change carries, never the command", () => {
    const d = texts(
      window(bash("cd web && GITHUB_TOKEN=ghp_abcdef123456 bunx vitest run src/cap.test.ts 2>&1 | tail -5", "error"), bash("bunx vitest run src/cap.test.ts", "success")),
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

  it("counts a run only with the runner in command position", () => {
    expect(texts(window(bash("ls node_modules/.bin/vitest", "error"), bash('echo "=== vitest ==="', "error"), bash("rg -n jest src/", "error")))).toEqual([]);
  });

  it("says nothing about runs that only passed", () => {
    expect(texts(window(bash("npx jest", "success")))).toEqual([]);
  });
});

describe("decisionsIn: reverts and design notes", () => {
  it("reports a revert by its description, and by a fixed label when the description is missing or unshareable", () => {
    expect(
      texts(
        window(
          bash("git revert --no-edit HEAD", "success", "Revert the bot's autofix"),
          bash('git checkout HEAD -- "/Users/t/wt/src/a.ts"', "success"),
          bash("git reset --hard origin/x", "success", "Reset /home/t/wt to the remote"),
        ),
      ),
    ).toEqual(["reverted: Revert the bot's autofix", "reverted: git checkout --", "reverted: git reset --hard"]);
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

describe("shareable", () => {
  it("drops a line naming a local path, a URL, an email or something shaped like a secret", () => {
    for (const line of [
      "The root cause is in /Users/taylor/code/app/src/auth.ts because the cookie is dropped.",
      "found it in ~/.datadog-keys because the CLI reads it",
      "can we look at file:///Users/t/dashboard.html",
      "See https://user:pw@host.com/x because it broke.",
      "the taylor@example.com credential is dead",
      "here is the key sk-ant-api03-XXXXXXXX use it",
      "set API_KEY=abc because the old one expired",
    ]) {
      expect(shareable(line), line).toBe(false);
    }
    expect(shareable("I kept warn instead of stop, so steps 4 and 9 behave the same.")).toBe(true);
  });

  it("is applied to everything a person or the agent says", () => {
    const d = texts(window(person("x"), person("use the token ghp_abcdefghijk instead of the old one"), said("The root cause is /home/t/x because it is missing here.")), [], true);
    expect(d).toEqual([]);
  });
});

describe("cap", () => {
  it("drops a code span the cut would leave open", () => {
    expect(cap("the flake in `platform-flows.spec.ts` is worth fixing", 20)).toBe("the flake in…");
  });
});

describe("chooseDecisions", () => {
  it("keeps corrections, test outcomes and reverts over findings, in session order", () => {
    const all = [
      { kind: "found" as const, text: "a" },
      { kind: "found" as const, text: "b" },
      { kind: "steered" as const, text: "c" },
      { kind: "tests" as const, text: "d" },
      { kind: "alternatives" as const, text: "e" },
    ];
    expect(chooseDecisions(all, 3).map((d) => d.text)).toEqual(["a", "c", "d"]);
    expect(chooseDecisions(all, 9)).toBe(all);
  });
});
