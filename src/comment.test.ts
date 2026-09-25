import { describe, expect, it } from "vitest";
import type { Brief } from "./brief.js";
import { COMMENT_MARKER, renderBrief, renderCheckRun, renderComment, reviewEffort } from "./comment.js";
import type { CommentContext } from "./comment.js";
import type { Selection } from "./types.js";

const REPO = "/r";
const ctx: CommentContext = { range: "main..HEAD", repo: REPO, version: "0.11.0" };

const subset: Selection = {
  kind: "subset",
  tests: ["/r/src/a.test.ts", "/r/src/b.test.ts"],
  blast: ["function use (/r/src/c.ts:2)", "file c.ts (/r/src/c.ts:1)", "function check (/r/src/a.test.ts:3)"],
  testsTotal: 40,
  files: [
    {
      path: "src/lib.ts",
      status: "modified",
      disposition: "mapped",
      symbols: ["parse", "tokenize", "emit", "walk"],
      reaches: [{ file: "/r/src/c.ts", symbols: ["use"] }],
      tests: ["/r/src/a.test.ts", "/r/src/b.test.ts"],
    },
    { path: "docs/guide.md", status: "modified", disposition: "ignored", symbols: [], reaches: [], tests: [] },
    { path: "docs/faq.md", status: "added", disposition: "ignored", symbols: [], reaches: [], tests: [] },
  ],
  edges: [
    { from: "/r/src/lib.ts", to: "/r/src/c.ts" },
    { from: "/r/src/c.ts", to: "/r/src/a.test.ts" },
    { from: "/r/src/lib.ts", to: "/r/src/b.test.ts" },
  ],
  contentRoot: "c".repeat(64),
};

describe("renderComment: subset", () => {
  it("leads with the marker and the verdict with its denominator", () => {
    const md = renderComment(subset, ctx);
    const lines = md.split("\n");
    expect(lines[0]).toBe(COMMENT_MARKER);
    expect(lines[1]).toBe("### Test impact: 2 of 40 test files reach this diff");
    expect(md).toContain("**2** of 40 `▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯` 5% of the suite");
  });

  it("shows repo-relative paths, never the absolute graph paths", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("- `src/a.test.ts`");
    expect(md).not.toContain("/r/src/a.test.ts");
  });

  it("links paths to the head blob and the shas to a compare view when the repo URL is known", () => {
    const md = renderComment(subset, {
      ...ctx,
      repoUrl: "https://github.com/o/r",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      prNumber: 587,
    });
    expect(md).toContain("[`src/a.test.ts`](https://github.com/o/r/blob/" + "b".repeat(40) + "/src/a.test.ts)");
    expect(md).toContain("| Summary | PR #587 at [`bbbbbbb`](https://github.com/o/r/compare/" + "a".repeat(40) + "..." + "b".repeat(40) + ") |");
    expect(md).toContain("| Compared against | base `aaaaaaa` |");
    expect(md).not.toContain("main..HEAD");
  });

  it("falls back to the raw range when the shas are unknown", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("| Summary | `main..HEAD` |");
  });

  it("tabulates each changed file with its symbols, reach and tests, grouping ignored files by directory", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("| Read | Changed file | Symbols touched | Reaches | Tests |");
    expect(md).toContain("| 1 | `src/lib.ts` | `parse`, `tokenize`, `emit`, +1 | 1 file | 2 |");
    expect(md).toContain("| | 2 files under `docs/` | ignored by policy | | 0 |");
    expect(md).toContain("| Changed | 3 files: 1 mapped to 4 symbols, 2 ignored by policy |");
    expect(md).toContain("| Downstream code | 1 file, 3 dependents · review effort low |");
  });

  it("orders the files by reach, reads a changed dependent right after the change it depends on, and puts test files last", () => {
    const chained: Selection = {
      ...subset,
      tests: ["/r/src/a.test.ts", "/r/src/b.test.ts", "/r/src/use.test.ts"],
      files: [
        { path: "src/use.test.ts", status: "modified", disposition: "mapped", symbols: ["check"], reaches: [], tests: ["/r/src/use.test.ts"] },
        // As select.ts builds them: a per-file walk never lists another changed file among its reaches,
        // so the changed-to-changed dependencies (lib -> use -> app, and lib -> app again) are only in `edges`.
        { path: "src/app.ts", status: "modified", disposition: "mapped", symbols: ["main"], reaches: [], tests: ["/r/src/use.test.ts"] },
        { path: "src/use.ts", status: "modified", disposition: "mapped", symbols: ["use"], reaches: [{ file: "/r/src/render.ts", symbols: ["draw"] }], tests: ["/r/src/use.test.ts"] },
        { path: "src/other.ts", status: "added", disposition: "mapped", symbols: ["other"], reaches: [], tests: ["/r/src/a.test.ts", "/r/src/b.test.ts"] },
        subset.files[0]!,
        { path: "src/lib.ts", status: "modified", disposition: "mapped", symbols: ["parse"], reaches: [{ file: "/r/src/c.ts", symbols: ["use"] }, { file: "/r/src/render.ts", symbols: ["draw"] }], tests: ["/r/src/a.test.ts", "/r/src/b.test.ts", "/r/src/use.test.ts"] },
      ].filter((f) => f.path !== "src/lib.ts" || f.symbols.length === 1),
      edges: [
        { from: "/r/src/lib.ts", to: "/r/src/use.ts" },
        { from: "/r/src/lib.ts", to: "/r/src/app.ts" },
        { from: "/r/src/use.ts", to: "/r/src/app.ts" },
        { from: "/r/src/app.ts", to: "/r/src/lib.ts" },
        { from: "/r/src/lib.ts", to: "/r/src/c.ts" },
        { from: "/r/src/use.ts", to: "/r/src/render.ts" },
        { from: "/r/src/lib.ts", to: "/r/src/use.test.ts" },
      ],
    };
    const rows = renderComment(chained, ctx).split("\n").filter((l) => /^\| (\d|with|\| \d+ files under)/.test(l));
    // use.ts is placed under lib.ts and app.ts under use.ts (a chain, not under lib.ts, which also reaches it);
    // the app -> lib back edge is a cycle the placed set ends; the test file is never grouped.
    expect(rows).toEqual([
      "| 1 | `lib.ts` | `parse` | 2 files | 3 |",
      "| with `lib.ts` | `use.ts` | `use` | 1 file | 1 |",
      "| with `use.ts` | `app.ts` | `main` |  | 1 |",
      "| 2 | `other.ts` (new) | `other` |  | 2 |",
      "| 3 | `use.test.ts` | test code, selected directly |  | 1 |",
    ]);
    expect(renderComment(chained, ctx)).toContain("| Downstream code | 2 files, 3 dependents · review effort medium |");
  });

  it("embeds the hosted figure with a dark and a light source when given", () => {
    const md = renderComment(subset, { ...ctx, figure: { kind: "image", dark: "https://x/d.svg", light: "https://x/l.svg" } });
    expect(md).toContain('<source media="(prefers-color-scheme: dark)" srcset="https://x/d.svg">');
    expect(md).toContain('src="https://x/l.svg"');
    expect(renderComment(subset, ctx)).not.toContain("<picture>");
  });

  it("embeds a mermaid figure as a fenced block with a shape legend", () => {
    const md = renderComment(subset, { ...ctx, figure: { kind: "mermaid", source: "graph LR\n  n0[[\"a.ts\"]] --> n1([\"a.test.ts\"])" } });
    expect(md).toContain("```mermaid\ngraph LR\n  n0[[\"a.ts\"]] --> n1([\"a.test.ts\"])\n```");
    expect(md).toContain("Changed files are double-bordered, tests are rounded");
    expect(md).not.toContain("<picture>");
  });

  it("groups the blast radius by changed file behind a fold", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("<details><summary>Blast radius by changed file: 3 dependents</summary>");
    expect(md).toContain("- `src/lib.ts` reaches `use` (`src/c.ts`)");
  });

  it("carries the version and the graph root in the footer", () => {
    const md = renderComment(subset, ctx);
    expect(md).toContain("blastline 0.11.0");
    expect(md).toContain("Graph `ccccccc`");
  });

  it("states plainly when a clean subset selects zero tests", () => {
    const md = renderComment({ ...subset, tests: [], blast: [], files: [], edges: [] }, ctx);
    expect(md).toContain("### Test impact: 0 of 40 test files reach this diff");
    expect(md).toContain("none: no test file depends on the changed code");
  });
});

describe("renderComment: fail-open", () => {
  it("renders every reason kind as a cause with an action, without throwing", () => {
    const md = renderComment(
      {
        kind: "all",
        reasons: [
          { kind: "unmapped-file", path: "x.json" },
          { kind: "stale-graph", expected: "e", actual: "a" },
          { kind: "sparse-graph", edgesPerFile: 1.9, threshold: 3 },
          { kind: "disconnected-tests", coverage: 0.1, threshold: 0.25 },
          { kind: "diff-too-large", files: 300, limit: 200 },
          { kind: "extraction-warning", path: "y.ts" },
          { kind: "graph-unavailable", detail: "no graph" },
          { kind: "no-test-files" },
          { kind: "selection-saturated", selected: 19, total: 20, threshold: 0.9 },
          { kind: "traversal-exhausted", visited: 5, budget: 4 },
          { kind: "invalid-ignore-pattern", pattern: "[", detail: "bad" },
        ],
      },
      ctx,
    );
    expect(md.split("\n")[0]).toBe(COMMENT_MARKER);
    expect(md).toContain("### Test impact: run the full suite");
    expect(md).toContain("> [!WARNING]");
    // ci.yml's action-selftest greps this exact phrase in blastline-comment.md
    expect(md).toContain("Run the full suite");
    expect(md).toContain("| Why | What you can do |");
    expect(md).toContain("| Graph looks under-extracted: 1.9 edges per file (floor 3) |");
    expect(md).toContain("x.json");
    expect(md).not.toContain("undefined");
    // ten non-unmapped reasons, one row each
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Why")).length).toBe(10);
  });

  // A real PR produced ~900 near-identical "has no graph node" bullets, burying
  // the verdict and every other reason. The paths still matter, so they are
  // grouped by directory and kept in full behind a fold -- never dropped.
  it("aggregates a large unmapped-file list instead of one bullet per file", () => {
    const reasons = Array.from({ length: 900 }, (_, i) => ({
      kind: "unmapped-file" as const,
      path: `research/evidence/run-${i}/result.json`,
    }));
    reasons.push({ kind: "unmapped-file" as const, path: "bench/only.json" });
    const md = renderComment({ kind: "all", reasons }, ctx);
    expect(md.split("\n").length).toBeLessThan(120);
    expect(md).toContain("901 files have no graph node");
    expect(md).toContain("add a pattern for them to `ignore`");
    expect(md).toContain("research/evidence/run-0");
    expect(md).toContain("bench");
    expect(md).toContain("more");
  });
});

const brief: Brief = {
  range: "main..HEAD",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  selection: subset,
  changeContext: {
    symbols: [
      { path: "src/lib.ts", label: "parse", kind: "function", status: "changed", line: 3 },
      { path: "src/lib.ts", label: "helper", kind: "function", status: "deleted_or_renamed", line: 1 },
      { path: "src/lib.ts", label: "emit", kind: "function", status: "added_or_renamed", line: 9 },
    ],
    budget: 20000,
    omitted: { impacts: 0, context: 388 },
    truncated: true,
  },
  commits: [
    {
      sha: "1".repeat(40),
      subject: "refactor(lib): inline helper, add emit",
      checkpointId: "01M3AY9296319GSPWRKXGHXMH5",
      checkpoint: {
        id: "01M3AY9296319GSPWRKXGHXMH5",
        commit: "1".repeat(40),
        agent: "Claude Code",
        model: "claude-sonnet-5",
        prompt: "Remove helper from src/lib.ts and inline it into parse; add emit.",
        filesTouched: ["src/lib.ts"],
        testCommands: ["bunx vitest run src/a.test.ts"],
        source: "entire",
      },
      files: ["src/lib.ts"],
      reach: { files: 1, tests: 2 },
      reachingTests: ["src/a.test.ts", "src/b.test.ts"],
      ranReachingTests: ["src/a.test.ts"],
    },
    {
      sha: "2".repeat(40),
      subject: "docs: guide",
      files: ["docs/guide.md", "docs/faq.md"],
      reach: { files: 0, tests: 0 },
      reachingTests: [],
      ranReachingTests: [],
    },
    {
      sha: "3".repeat(40),
      subject: "chore: unpushed checkpoint",
      checkpointId: "01M3AY9296319GSPWRKXGHXZZZ",
      files: ["src/lib.ts"],
      reach: { files: 1, tests: 2 },
      reachingTests: ["src/a.test.ts", "src/b.test.ts"],
      ranReachingTests: [],
    },
  ],
  claims: [
    { claim: "`1111111` ran the tests it reaches", verdict: "partial", evidence: "ran 1 of 2: src/a.test.ts; not run: src/b.test.ts" },
    { claim: "`helper` removed from `src/lib.ts`", verdict: "refuted", evidence: "still referenced by `use` (src/use.ts:3) in files this diff does not touch" },
    { claim: "`1111111` commits what the agent touched", verdict: "consistent", evidence: "all 1 touched file are in the commit" },
  ],
  sincePrevious: { head: "9".repeat(40), commits: 1, files: 1, tests: 0, newlyReached: ["src/c.ts"] },
  annotations: [
    { path: "src/lib.ts", start_line: 3, end_line: 4, annotation_level: "notice", title: "blastline: reach", message: "Reaches 1 file and 2 test files through parse." },
  ],
  unchecked: [],
  snapshot: { head: "b".repeat(40), commits: 3, files: 3, tests: 2, reached: ["src/c.ts"] },
};

describe("renderBrief: subset", () => {
  it("keeps the comment marker first so the Action edits the existing comment, and embeds its snapshot", () => {
    const lines = renderBrief(brief, ctx).split("\n");
    expect(lines[0]).toBe(COMMENT_MARKER);
    expect(lines[1]).toBe(`<!-- blastline:brief ${JSON.stringify(brief.snapshot)} -->`);
    expect(lines[2]).toBe("### PR brief: 1 agent commit · 2 of 40 test files reach this diff");
  });

  it("adds the intent, symbols and since-push rows to the summary", () => {
    const md = renderBrief(brief, ctx);
    expect(md).toContain("| Intent | 1 of 3 commits carry a checkpoint · `claude-sonnet-5` · 1 not fetched · 1 unattributed |");
    expect(md).toContain("| Symbols | 1 changed, 1 added, 1 removed within the diff |");
    expect(md).toContain("| Since push `9999999` | 1 new commit, +1 changed file, 0 tests reached, newly reaches `src/c.ts` |");
    expect(md).toContain("| Tests reached | **2** of 40");
    expect(renderBrief(brief, { ...ctx, baseSha: "a".repeat(40), headSha: "b".repeat(40) })).toContain("| Compared against | base `aaaaaaa` |");
  });

  it("tabulates each commit with its intent, files, reach and what ran before the push", () => {
    const md = renderBrief(brief, { ...ctx, repoUrl: "https://github.com/o/r" });
    expect(md).toContain("#### What each commit did");
    expect(md).toContain("| Commit | Intent | Files | Reaches | Ran before push |");
    expect(md).toContain(
      "| [`1111111`](https://github.com/o/r/commit/" + "1".repeat(40) + ") refactor(lib): inline helper, add emit | Remove helper from src/lib.ts and inline it into parse; add emit. <sub>Claude Code · claude-sonnet-5</sub> | 1 file | 1 file, 2 tests | 1 of 2 reaching tests |",
    );
    expect(md).toContain("docs: guide | _no checkpoint_ | 2 files |  |  |");
    expect(md).toContain("chore: unpushed checkpoint | _checkpoint `01M3AY9296319GSPWRKXGHXZZZ` not fetched_ | 1 file | 1 file, 2 tests |  |");
    expect(md).not.toContain("<details><summary>3 commits");
  });

  it("lists claims refuted first and never prints a certificate", () => {
    const md = renderBrief(brief, ctx);
    const claims = md.slice(md.indexOf("#### Claims checked"));
    expect(claims.indexOf("**refuted**")).toBeLessThan(claims.indexOf("**partial**"));
    expect(claims.indexOf("**partial**")).toBeLessThan(claims.indexOf("**consistent**"));
    expect(md).toContain("- **refuted**: `helper` removed from `src/lib.ts`. still referenced by `use` (src/use.ts:3) in files this diff does not touch.");
    expect(md.toLowerCase()).not.toContain("verified");
  });

  it("replaces the symbols column with what changed per symbol when change-context is present", () => {
    const md = renderBrief(brief, ctx);
    expect(md).toContain("| Read | Changed file | Change | Reaches | Tests |");
    expect(md).toContain("| `src/lib.ts` | `parse` changed, `helper` removed, `emit` added | 1 file | 2 |");
    expect(md).toContain("| | 2 files under `docs/` | ignored by policy | | 0 |");
  });

  it("prints the change-context counters and checkpoint coverage in the footer", () => {
    const md = renderBrief(brief, ctx);
    expect(md).toContain("change-context budget 20000: omitted 0 impacts, 388 context entries (truncated); symbols are classified within the diff only.");
    expect(md).toContain("Intent: 1 of 3 commits.");
    expect(md).toContain("Graph `ccccccc`");
    expect(md).toContain("#pr-brief");
  });

  it("folds the commit table after ten commits", () => {
    const many = { ...brief, commits: Array.from({ length: 11 }, (_, i) => ({ ...brief.commits[1]!, sha: String(i).padStart(40, "0"), subject: `c${i}` })) };
    const md = renderBrief(many, ctx);
    expect(md).toContain("<details><summary>11 commits</summary>");
    expect(md).toContain("| `0000000` c0 |");
  });
});

describe("renderBrief: no checkpoints, fail-open", () => {
  const bare: Brief = {
    range: "main..HEAD",
    selection: { kind: "all", reasons: [{ kind: "graph-unavailable", detail: "no graph" }] },
    commits: [
      { sha: "4".repeat(40), subject: "feat: x", files: ["src/x.ts"], reach: { files: 0, tests: 0 }, reachingTests: [], ranReachingTests: [] },
    ],
    claims: [],
    annotations: [],
    unchecked: ["symbol changes: no `--change-context` given"],
    snapshot: { head: "main..HEAD", commits: 1, files: 0, tests: 0, reached: [] },
  };

  it("keeps the full-suite warning and says plainly that no checkpoint and no change-context exist", () => {
    const md = renderBrief(bare, ctx);
    expect(md.split("\n")[0]).toBe(COMMENT_MARKER);
    expect(md).toContain("### PR brief: 0 agent commits · run the full suite");
    expect(md).toContain("Run the full suite");
    expect(md).toContain("| Intent | no checkpoints on this branch (1 commit): no `Entire-Checkpoint` or `Agent-Logs-Url` trailer, no vendor address |");
    expect(md).not.toContain("| Symbols |");
    expect(md).toContain("| `4444444` feat: x | _no checkpoint_ | 1 file |  |  |");
    expect(md).toContain("_no checkpoint on this branch makes a claim the graph can check_");
    expect(md).toContain("Not checked: symbol changes: no `--change-context` given.");
    expect(md).toContain("Intent: 0 of 1 commit.");
    expect(md).not.toContain("undefined");
  });
});

describe("renderCheckRun", () => {
  it("builds one completed neutral check run per head sha with the brief's annotations", () => {
    const md = renderBrief(brief, ctx);
    const run = renderCheckRun(brief, md, "b".repeat(40));
    expect(run).toMatchObject({ name: "blastline", head_sha: "b".repeat(40), status: "completed", conclusion: "neutral" });
    expect(run.output.title).toBe("PR brief: 1 agent commit · 2 of 40 test files reach this diff");
    expect(run.output.summary).toContain("| Intent |");
    expect(run.output.summary).not.toContain("<!-- ");
    expect(run.output.text).toContain("#### What each commit did");
    expect(run.output.annotations).toEqual(brief.annotations);
  });
});

describe("renderBrief: a commit attributed by trailer", () => {
  const attributed: Brief = {
    range: "main..HEAD",
    selection: { kind: "all", reasons: [{ kind: "graph-unavailable", detail: "no graph" }] },
    commits: [
      {
        sha: "5".repeat(40),
        subject: "feat: retry fetch",
        provenance: { agent: "copilot", via: "Agent-Logs-Url", logsUrl: "https://github.com/o/r/sessions/01ABC" },
        files: ["src/x.ts"],
        reach: { files: 0, tests: 0 },
        reachingTests: [],
        ranReachingTests: [],
      },
      { sha: "6".repeat(40), subject: "fix: typo", provenance: { agent: "claude-code", via: "author" }, files: ["src/y.ts"], reach: { files: 0, tests: 0 }, reachingTests: [], ranReachingTests: [] },
      { sha: "7".repeat(40), subject: "docs: by hand", files: ["README.md"], reach: { files: 0, tests: 0 }, reachingTests: [], ranReachingTests: [] },
    ],
    claims: [],
    annotations: [],
    unchecked: [],
    snapshot: { head: "main..HEAD", commits: 3, files: 0, tests: 0, reached: [] },
  };

  it("counts trailer-attributed commits as agent commits, links the session log, and says who is unattributed", () => {
    const md = renderBrief(attributed, ctx);
    expect(md).toContain("### PR brief: 2 agent commits · run the full suite");
    expect(md).toContain("| Intent | 2 of 3 commits attributed by trailer (copilot, claude-code) · 1 unattributed |");
    expect(md).toContain("| `5555555` feat: retry fetch | _copilot by Agent-Logs-Url_ · [session log](https://github.com/o/r/sessions/01ABC) | 1 file |  |  |");
    expect(md).toContain("| `6666666` fix: typo | _claude-code by author_ | 1 file |  |  |");
    expect(md).toContain("| `7777777` docs: by hand | _no checkpoint_ | 1 file |  |  |");
    expect(md).toContain("Intent: 0 of 3 commits, 2 attributed by trailer.");
    expect(md).not.toContain("undefined");
  });

  it("counts an unattributed commit even beside an unfetched checkpoint and a checkpointed one", () => {
    const mixed: Brief = {
      ...attributed,
      commits: [
        brief.commits[0]!,
        { sha: "8".repeat(40), subject: "chore: unpushed ref", checkpointId: "01M3AY9296319GSPWRKXGHXQQQ", files: ["src/z.ts"], reach: { files: 0, tests: 0 }, reachingTests: [], ranReachingTests: [] },
        attributed.commits[2]!,
      ],
    };
    expect(renderBrief(mixed, ctx)).toContain("| Intent | 1 of 3 commits carry a checkpoint · `claude-sonnet-5` · 1 not fetched · 1 unattributed |");
  });
});

describe("reviewEffort", () => {
  it("tiers by dependents and mapped files with fixed thresholds", () => {
    expect(reviewEffort(0, 1)).toBe("low");
    expect(reviewEffort(4, 3)).toBe("low");
    expect(reviewEffort(5, 1)).toBe("medium");
    expect(reviewEffort(1, 4)).toBe("medium");
    expect(reviewEffort(19, 9)).toBe("medium");
    expect(reviewEffort(20, 1)).toBe("high");
    expect(reviewEffort(0, 10)).toBe("high");
  });
});
