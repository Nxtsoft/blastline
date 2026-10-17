import { describe, expect, it } from "vitest";
import { chooseDecisions, decisionsIn, findingIn } from "./decisions.js";

// Records in the compact transcript's shape (Entire transcript format v1): tool results inlined into the tool_use.
const person = (text: string): string => JSON.stringify({ type: "user", content: [{ text }] });
const said = (text: string): string => JSON.stringify({ type: "assistant", content: [{ type: "text", text }] });
const bash = (command: string, status: "success" | "error", description = ""): string =>
  JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command, description }, result: { output: "SECRET OUTPUT", status } }] });
const agent = (description: string, subagent_type = "general-purpose"): string =>
  JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Agent", input: { description, prompt: "SECRET BRIEF", subagent_type }, result: { output: "SECRET RESULT", status: "success" } }] });
const write = (file_path: string, content: string): string => JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path, content }, result: { output: "ok", status: "success" } }] });
const window = (...records: string[]): string => records.join("\n");

describe("decisionsIn: what the person said", () => {
  it("takes the request that opened the turn, skips a bare go-ahead, and calls a later instruction steering", () => {
    const d = decisionsIn(window(person("move the round-size cap into one module"), said("On it."), person("sounds good let's do it"), person("keep the old export for the eval harness")), []);
    expect(d.map((x) => [x.kind, x.text])).toEqual([
      ["asked", "move the round-size cap into one module"],
      ["steered", "keep the old export for the eval harness"],
    ]);
  });

  it("calls the first thing a person says steering when the window continues a turn", () => {
    const d = decisionsIn(window(said("Pushed."), person("you used the wrong git author on the last commit")), [], false);
    expect(d).toEqual([{ kind: "steered", text: "you used the wrong git author on the last commit", at: 1 }]);
  });

  it("never takes harness text for a person: hook feedback, notifications, the agents run preamble, an image caption", () => {
    const d = decisionsIn(
      window(
        person("Stop hook feedback:\n[~/.agents/hooks/stop.sh]: run the tests"),
        person("<task-notification>\n<summary>CI green</summary>\n</task-notification>"),
        person("You are in a git worktree of app on branch fix/x at /home/t/wt.\nfix the login redirect"),
        JSON.stringify({ type: "user", content: [{ text: "[Image: source: /Users/t/Desktop/s.png]" }, { text: "the header overlaps on mobile" }] }),
      ),
      [],
    );
    expect(d.map((x) => x.text)).toEqual(["fix the login redirect", "the header overlaps on mobile"]);
  });
});

describe("findingIn: what the agent found or chose", () => {
  it("takes the first sentence that gives a reason or an alternative", () => {
    expect(findingIn("Read the three call sites. I kept warn instead of stop, so the same calculation behaves the same on every step. Pushing now.")).toBe(
      "I kept warn instead of stop, so the same calculation behaves the same on every step.",
    );
    expect(findingIn("- **Root cause:** the cache key ignores the tenant, so two tenants share one entry.")).toBe("Root cause: the cache key ignores the tenant, so two tenants share one entry.");
  });

  it("skips progress chatter, a bare 'found X', clean tool output and fenced code", () => {
    expect(findingIn("Still waiting on CI because the runner is slow today.")).toBeUndefined();
    expect(findingIn("Found the step 4 import sites.")).toBeUndefined();
    expect(findingIn("Typecheck printed no errors and ESLint found 0 errors.")).toBeUndefined();
    expect(findingIn("The fix is merged and the deployment is green.")).toBeUndefined();
    expect(findingIn("```\nthe root cause is in here because reasons\n```")).toBeUndefined();
  });
});

describe("decisionsIn: tests, reverts, reviews, design notes", () => {
  it("reports a test command that failed and then passed once, however it was prefixed or piped", () => {
    const d = decisionsIn(
      window(bash("cd web && bunx vitest run src/cap.test.ts 2>&1 | tail -5", "error"), bash("bunx vitest run src/cap.test.ts", "success"), bash("bunx vitest run src/other.test.ts", "success")),
      [],
    );
    expect(d).toEqual([{ kind: "tests", text: "failed, then passed: bunx vitest run src/cap.test.ts", at: 0 }]);
  });

  it("reports a test command whose last run failed", () => {
    const d = decisionsIn(window(bash("pytest tests/test_cap.py", "success"), bash("pytest tests/test_cap.py", "error")), []);
    expect(d.map((x) => x.text)).toEqual(["last run failed: pytest tests/test_cap.py"]);
  });

  it("reports a revert by its description, and not an unstage", () => {
    const d = decisionsIn(window(bash("git revert --no-edit HEAD", "success", "Revert the bot's autofix"), bash("git restore --staged src/a.ts && git commit -m x", "success", "Commit the fix")), []);
    expect(d).toEqual([{ kind: "reverted", text: "Revert the bot's autofix", at: 0 }]);
  });

  it("reports a review the agent dispatched by its description, never its brief or result", () => {
    const d = decisionsIn(window(agent("Review PR 621 for the round cap"), agent("Find the call sites")), []);
    expect(d).toEqual([{ kind: "review", text: "Review PR 621 for the round cap", at: 0 }]);
  });

  it("reports design notes that weigh alternatives only when the change carries them, by their repo path", () => {
    const notes = "# Design\n\n## Alternatives considered\n\nA cache per tenant.";
    const d = decisionsIn(window(write("/Users/t/wt/openspec/changes/cap/design.md", notes), write("/Users/t/notes/scratch.md", notes)), ["openspec/changes/cap/design.md"]);
    expect(d).toEqual([{ kind: "alternatives", text: "openspec/changes/cap/design.md", at: 0 }]);
  });

  it("never carries tool output, an agent's brief or its result", () => {
    const d = decisionsIn(window(bash("bunx vitest run a.test.ts", "error"), bash("bunx vitest run a.test.ts", "success"), agent("Review the change")), []);
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });
});

describe("chooseDecisions", () => {
  it("keeps corrections, test outcomes and reverts over the opening request, in session order", () => {
    const all = [
      { kind: "asked" as const, text: "a" },
      { kind: "found" as const, text: "b" },
      { kind: "steered" as const, text: "c" },
      { kind: "tests" as const, text: "d" },
      { kind: "review" as const, text: "e" },
    ];
    expect(chooseDecisions(all, 3).map((d) => d.text)).toEqual(["b", "c", "d"]);
    expect(chooseDecisions(all, 9)).toBe(all);
  });
});
