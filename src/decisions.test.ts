import { describe, expect, it } from "vitest";
import { cap, chooseDecisions, decisionsIn, findingIn, shareable } from "./decisions.js";

// Records in the compact transcript's shape (Entire transcript format v1): tool results inlined into the tool_use.
const person = (...texts: string[]): string => JSON.stringify({ type: "user", content: texts.map((text) => ({ text })) });
const said = (text: string): string => JSON.stringify({ type: "assistant", content: [{ type: "text", text }] });
const bash = (command: string, status: "success" | "error", description = ""): string =>
  JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command, description }, result: { output: "SECRET OUTPUT", status } }] });
const write = (file_path: string, content: string): string => JSON.stringify({ type: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path, content }, result: { output: "ok", status: "success" } }] });
const window = (...records: string[]): string => records.join("\n");
const texts = (window: string, files: string[] = []): string[] => decisionsIn(window, files).map((d) => `${d.kind}: ${d.text}`);

describe("decisionsIn: what a person typed", () => {
  it("is never quoted, however it is worded", () => {
    expect(texts(window(person("move the round-size cap into one module"), person("no, use the router-driven key instead because the bot broke it"), person("use pass qwhtnzmr instead")))).toEqual([]);
  });

  it("leaves out an agent's sentence about operating the change: git authors, staging, merges, other PRs", () => {
    expect(findingIn("The fix for #742 regressed because the key was dropped.")).toBeUndefined();
    expect(findingIn("I switched to the right git author because Vercel blocked the deploy.")).toBeUndefined();
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
      "no, the .env is at C:\\Users\\bob\\acme\\.env not the repo one",
      "it lives on \\\\fileserver\\share\\keys",
      "check ~bob/notes because they differ",
      "it reads $HOME/.ssh/id_rsa instead",
      "the runner checks out to /github/workspace/src because of actions",
      "the data sits in /srv/acme/secrets instead",
      "the file **/home/taylor/x.ts** is wrong",
      "see [/home/taylor/x] because it broke",
      "see github.com/Acme/secret-repo/pull/12 instead",
      "open www.acme-internal.com/admin because it is down",
      "the dashboard at acme-internal.com broke",
      "![x](//evil.example/p.png)",
      "Revert the change that exposed glpat-AbCdEfGhIjKlMnOp",
      "use rk_live_AbCdEfGh1234 instead",
      "npm_AbCdEfGh1234567890 is the publish token",
      "hf_AbCdEfGhIjKlMnOp works",
      "send Bearer abcdef0123456789xyz with it",
      "-----BEGIN RSA PRIVATE KEY----- was pasted",
      "the AWS secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY is set",
      "the password is hunter2-prod, use that instead",
      "The root cause is the DB at 10.20.0.7:5432 rejecting us because the role lacks CONNECT.",
      "the API on localhost:3000 broke because the port moved",
      "the hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 matched",
      // The second review's probes: shapes a deny-list let through.
      "it broke because gcc got -I/home/taylor/acme/include first",
      "it was in.../home/bob/acme/creds.json because of the default",
      "the key is in %APPDATA%\\acme\\creds.json because of Windows",
      "Authorization: Basic dXNlcjpwYXNzd29yZA== broke",
      "use xY7_kP2-mN9qR4_tL8-vB3zW6_cF1qA because the old one expired",
      "use k9x2m4p7q1w8e5r3t6y0u2i4o6 instead",
      "PGPASSWORD hunter2-prod works instead",
      "use pass hunter2 instead",
      "user acme-admin, pass Winter2026! instead",
      "use the sk_ant_api03XyzAbc instead",
      "use the lin_api_AbCdEfGhIjKl instead",
      "jenkins.acme.tech rejects us because of the cert",
      "the db is acme-prod-db:5432 because of the move",
      "fe80::1 rejects us because of the route",
      "ask &#64;octocat about it",
      "see cli/cli&#35;1 for it",
      "the --/home/taylor/x flag broke",
      "use AKIAIOSFODNNEXAMPLE because it works",
      "the token AbCdEfGhIjKlMnOpQrSt is set",
      // The third review's probes: secrets built of letters, and words said to be one.
      "use the app password qwhtnzmrkdlpbxva for the SMTP login instead",
      "the password is correcthorsebatterystaple instead",
      "API_KEY = kqzxvbnmwplrtyhgfdsa because the old one expired",
      "the recovery code is ABCDE-FGHIJ-KLMNO instead",
      "the passphrase is Purple-Monkey-Dishwasher instead",
      "the PIN is 4821 instead of the old one",
      "the OTP was 123.456 when it failed",
      "AKIAIOSFODNN broke because of the rotation",
      "the value шифрпаролькоторыйдлинный is set",
      "hf_abcdefghijklmnopqrstuvwxyz broke",
      "use dyrpyeubx12yn1jr7m19ulab because it works",
      "use pass qwhtnzmr instead",
      "the host is at `acme.internal.tech` because of the move",
      "The token is refreshed before expiry because the clock skews.",
    ]) {
      expect(shareable(line), line).toBe(false);
    }
    const files = ["src/round-size.ts", "openspec/changes/cap/design.md"];
    expect(shareable("the edit went to /home/taylor/wt/src/round-size.ts because of the worktree", files)).toBe(false);
    for (const line of [
      "I kept warn instead of stop, so steps 4 and 9 behave the same.",
      "The cap moved to src/round-size.ts because two modules each had one.",
      "I chose `useRoundSizeCap` over a context so `openspec/changes/cap/design.md` stays the source.",
      "CodeRabbit, stop vs warn: I kept \"add the calculation and warn\" instead of \"stop the import\", so the same calculation behaves the same on steps 4, 7 and 9.",
      "useScenarioSummaryForStep4Query re-ran because its key changed in `round-size.ts`.",
      "The refresh runs before expiry because the clock skews; ASIA_PACIFIC_REGION is read instead of the default.",
      "The fix is to call `useEffect()` instead of `useLayoutEffect()` because SSR warns.",
      "I chose `Array.from` instead of spread because the iterator is lazy.",
      "Root cause: `scenario?.summary` is undefined because the step loads later.",
      "The bug is that `step >= 9` should be `step > 9` because step 9 is inclusive.",
      "I chose v2 of the API instead because v1 is deprecated.",
      "I kept the e2e helper instead because i18n strings differ.",
      "Mesmer found a real gap: if the summary goes away while the page stays mounted, the section is never cleared.",
    ]) {
      expect(shareable(line, files), line).toBe(true);
    }
  });

  it("passes no random token: lower case, lower case with digits, base36, mixed-case letters", () => {
    // A fixed-seed generator, so a failure names the same token every run.
    let seed = 42;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const draw = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    const lower = "abcdefghijklmnopqrstuvwxyz";
    for (const [alphabet, n] of [
      [lower, 16],
      [lower, 24],
      [`${lower}0123456789`, 32],
      [`${lower}0123456789`, 24],
      [`${lower}ABCDEFGHIJKLMNOPQRSTUVWXYZ`, 32],
      [`${lower}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`, 20],
    ] as const) {
      const leaked = Array.from({ length: 1000 }, () => draw(alphabet, n)).filter((t) => shareable(`use ${t} instead`));
      expect(leaked, `${n} of ${alphabet}`).toEqual([]);
    }
  });

  it("is applied to everything a person or the agent says", () => {
    const d = texts(window(said("I used the token ghp_aB3dE6gH9jK2mN5pQ8 instead of the old one."), said("The root cause is /home/t/x because it is missing here.")));
    expect(d).toEqual([]);
  });
});

describe("cap", () => {
  it("drops a code span the cut would leave open", () => {
    expect(cap("the flake in `platform-flows.spec.ts` is worth fixing", 20)).toBe("the flake in…");
  });
});

describe("chooseDecisions", () => {
  it("keeps test outcomes and reverts over findings, in session order", () => {
    const all = [
      { kind: "found" as const, text: "a" },
      { kind: "found" as const, text: "b" },
      { kind: "reverted" as const, text: "c" },
      { kind: "tests" as const, text: "d" },
      { kind: "alternatives" as const, text: "e" },
    ];
    expect(chooseDecisions(all, 3).map((d) => d.text)).toEqual(["a", "c", "d"]);
    expect(chooseDecisions(all, 9)).toBe(all);
  });
});
