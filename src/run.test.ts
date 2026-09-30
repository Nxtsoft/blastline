import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSelection } from "./run.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

const DIFF = `diff --git a/src/lib.ts b/src/lib.ts
index 1..2 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -9,0 +10,1 @@
+  x();
`;

describe("runSelection", () => {
  it("selects from direct diff text against an explicit graph", () => {
    const sel = runSelection({ repo: "/anywhere", diffText: DIFF, graphPath: FIXTURE, minDensity: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.tests).toEqual(["/repo/src/lib.test.ts"]);
  });

  it("fails open instead of throwing when the graph path is unreadable", () => {
    const sel = runSelection({ repo: "/anywhere", diffText: DIFF, graphPath: "/nope/graph.json" });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("graph-unavailable");
  });

  it("fails open when no diff source is given at all", () => {
    const sel = runSelection({ repo: "/anywhere", graphPath: FIXTURE });
    expect(sel.kind).toBe("all");
  });

  it("applies ignore regexes supplied as strings", () => {
    const withDoc = DIFF + `diff --git a/README.md b/README.md
index 3..4 100644
--- a/README.md
+++ b/README.md
@@ -1,0 +2,1 @@
+hi
`;
    const sel = runSelection({
      repo: "/anywhere",
      diffText: withDoc,
      graphPath: FIXTURE,
      minDensity: 0,
      ignore: ["\\.md$"],
    });
    expect(sel.kind).toBe("subset");
  });

  it("names an unparseable ignore pattern instead of blaming the graph", () => {
    // A glob passed where a regex is expected — `**` is "nothing to repeat".
    const sel = runSelection({
      repo: "/anywhere",
      diffText: DIFF,
      graphPath: FIXTURE,
      minDensity: 0,
      ignore: ["openspec/**"],
    });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    const reason = sel.reasons[0];
    expect(reason?.kind).toBe("invalid-ignore-pattern");
    if (reason?.kind !== "invalid-ignore-pattern") return;
    expect(reason.pattern).toBe("openspec/**");
    // The graph is readable here; the old code reported graph-unavailable.
    expect(sel.reasons.some((r) => r.kind === "graph-unavailable")).toBe(false);
  });

  it("rejects a bad ignore pattern even when the graph is unreadable", () => {
    // Pattern validation precedes graph loading, so the operator error wins.
    const sel = runSelection({
      repo: "/anywhere",
      diffText: DIFF,
      graphPath: "/nope/graph.json",
      ignore: ["["],
    });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    expect(sel.reasons[0]?.kind).toBe("invalid-ignore-pattern");
  });

  it("marks the unmapped files nothing at the range's head names", () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const repo = join(mkdtempSync(join(tmpdir(), "blastline-run-")), "repo");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    mkdirSync(join(repo, "deploy"));
    writeFileSync(join(repo, "compose.yml"), "build: deploy/Dockerfile\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(repo, "deploy/Dockerfile"), "FROM scratch\n");
    writeFileSync(join(repo, "deploy/notes.txt"), "on-call rota\n");
    writeFileSync(join(repo, "compose.yml"), "build: deploy/Dockerfile\nimage: x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");

    const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath: FIXTURE, minDensity: 0 });
    expect(sel.kind).toBe("all");
    if (sel.kind !== "all") return;
    const unmapped = sel.reasons.filter((r) => r.kind === "unmapped-file");
    // compose.yml names the Dockerfile, and "deploy" names notes.txt's folder;
    // nothing names compose.yml.
    expect(unmapped).toEqual([
      { kind: "unmapped-file", path: "compose.yml", unnamed: true, caveats: ["no code reads it"] },
      { kind: "unmapped-file", path: "deploy/Dockerfile", caveats: ["compose.yml mentions it; nothing found runs it", "no code reads it"] },
      { kind: "unmapped-file", path: "deploy/notes.txt", caveats: ["no code reads it"] },
    ]);
  });

  it("keeps the verdict and drops only the suggestion when the search cannot run", () => {
    const withConfig = `diff --git a/deploy.yml b/deploy.yml
index 3..4 100644
--- a/deploy.yml
+++ b/deploy.yml
@@ -1,0 +2,1 @@
+x: 1
`;
    const sel = runSelection({ repo: "/nonexistent-repo", diffText: withConfig, graphPath: FIXTURE, minDensity: 0 });
    expect(sel).toEqual({ kind: "all", reasons: [{ kind: "unmapped-file", path: "deploy.yml" }] });
  });

  // The shape of a real web-app PR: two scripts wired into package.json beside
  // a code change. The manifest used to fail the whole run open.
  describe("a package.json change that only adds scripts nothing runs", () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const pkg = (scripts: Record<string, string>, deps = "15.0.0") =>
      `${JSON.stringify({ name: "app", scripts, dependencies: { next: deps } }, null, 2)}\n`;
    const lib = (tag: string) => Array.from({ length: 20 }, (_, i) => `// ${i === 4 ? tag : "line"}`).join("\n") + "\n";

    function range(head: { pkg: string; workflow?: string; lib?: string; extra?: Record<string, string> }): { repo: string; graphPath: string } {
      const repo = join(mkdtempSync(join(tmpdir(), "blastline-manifest-")), "repo");
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "package.json"), pkg({ test: "vitest run" }));
      writeFileSync(join(repo, "src/lib.ts"), head.lib ?? lib("base"));
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      writeFileSync(join(repo, "package.json"), head.pkg);
      writeFileSync(join(repo, "src/lib.ts"), head.lib ?? lib("head")); // line 5, inside parse
      for (const [path, text] of Object.entries(head.extra ?? {})) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      if (head.workflow !== undefined) {
        mkdirSync(join(repo, ".github/workflows"), { recursive: true });
        writeFileSync(join(repo, ".github/workflows/ci.yml"), head.workflow);
      }
      git("add", "-A");
      git("commit", "-q", "-m", "head");
      // Copied after the commits, so the graph is not older than the head.
      const graphPath = join(repo, "graph.json");
      copyFileSync(FIXTURE, graphPath);
      // Pinned an hour ahead: the stale-graph guard compares whole-second commit
      // times, and a copy in the commit's own second must not read as older.
      const later = new Date(Date.now() + 3_600_000);
      utimesSync(graphPath, later, later);
      return { repo, graphPath };
    }

    it("selects the code change's tests and says why the manifest cannot matter", () => {
      const { repo, graphPath } = range({ pkg: pkg({ test: "vitest run", "docs:check": "bun run scripts/docs.ts" }) });
      const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath, minDensity: 0, ignore: ["^graph\\.json$"] });
      expect(sel.kind).toBe("subset");
      if (sel.kind !== "subset") return;
      expect(sel.tests).toEqual(["/repo/src/lib.test.ts"]);
      expect(sel.files.find((f) => f.path === "package.json")).toEqual({
        path: "package.json",
        status: "modified",
        disposition: "ignored",
        why: "only adds scripts nothing runs: docs:check",
        symbols: [],
        reaches: [],
        tests: [],
      });
    });

    // Only the manifest changes; code that already spawns the new script (line 5,
    // inside parse) is walked like a changed line, and its test is selected.
    it("walks the code that names a new script", () => {
      const spawner = lib("x").replace("// x", 'spawnSync("bun", ["run", "docs:check"]);');
      const { repo, graphPath } = range({ pkg: pkg({ test: "vitest run", "docs:check": "bun run scripts/docs.ts" }), lib: spawner });
      const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath, minDensity: 0, ignore: ["^graph\\.json$"] });
      expect(sel.kind).toBe("subset");
      if (sel.kind !== "subset") return;
      expect(sel.tests).toEqual(["/repo/src/lib.test.ts"]);
      expect(sel.files).toEqual([
        expect.objectContaining({ path: "package.json", disposition: "mapped", why: "only adds scripts: docs:check; code naming them is walked", symbols: [] }),
      ]);
    });

    // Review of #52: code running scripts through a variable runner is walked.
    it("walks code that runs scripts through a variable runner", () => {
      const runner = lib("x").replace("// x", "execSync(`${pm} run ${name}`);");
      const { repo, graphPath } = range({ pkg: pkg({ test: "vitest run", "docs:check": "bun run scripts/docs.ts" }), lib: runner });
      const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath, minDensity: 0, ignore: ["^graph\\.json$"] });
      expect(sel.kind).toBe("subset");
      if (sel.kind !== "subset") return;
      expect(sel.tests).toEqual(["/repo/src/lib.test.ts"]);
    });

    it("still fails open when a workflow runs the new script", () => {
      const { repo, graphPath } = range({
        pkg: pkg({ test: "vitest run", "docs:check": "bun run scripts/docs.ts" }),
        workflow: "jobs:\n  t:\n    steps:\n      - run: bun run docs:check\n",
      });
      const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath, minDensity: 0, ignore: ["^graph\\.json$", "^\\.github/"] });
      expect(sel.kind).toBe("all");
      if (sel.kind !== "all") return;
      expect(sel.reasons.map((r) => r.kind === "unmapped-file" && r.path)).toContain("package.json");
    });

    // Review of #52: the range said "script added", the supplied diff said
    // "dependency bumped", and the range's verdict won.
    it("judges a supplied diff as supplied, not by the range beside it", () => {
      const { repo, graphPath } = range({ pkg: pkg({ test: "vitest run", "docs:check": "x" }) });
      const bump = `diff --git a/package.json b/package.json\nindex 1..2 100644\n--- a/package.json\n+++ b/package.json\n@@ -6,1 +6,1 @@\n-    "next": "15.0.0"\n+    "next": "16.0.0"\n`;
      const sel = runSelection({ repo, range: "HEAD~1..HEAD", diffText: bump, graphPath, minDensity: 0 });
      expect(sel.kind).toBe("all");
    });

    // Review of #52: CI running scripts by a name chosen at run time picks up
    // a new one, however the runner is spelled.
    for (const [file, text] of [
      ["package.json", ""],
      ["scripts/ci.sh", "for s in $SUITES; do echo $s; done | xargs -I{} npm run {}\n"],
      ["justfile", "e2e suite:\n  npm run {{suite}}\n"],
      ["scripts/ws.sh", 'for s in $SUITES; do npm run -w web "$s"; done\n'],
      ["scripts/pipe.sh", "echo $SUITES | xargs -n1 pnpm run\n"],
      [".github/workflows/suites.yml", "jobs:\n  e2e:\n    steps:\n      - run: ${{ env.PM }} run ${{ matrix.suite }}\n"],
      ["Makefile", "NPM ?= npm\ne2e:\n\t$(NPM) run $(SUITE)\n"],
    ] as const) {
      it(`fails open when ${file} runs scripts by a name chosen at run time`, () => {
        const scripts: Record<string, string> = { test: "vitest run", "docs:check": "bun run scripts/docs.ts" };
        if (file === "package.json") scripts["ci"] = 'for s in $SUITES; do "$npm_execpath" run $s; done';
        const { repo, graphPath } = range({ pkg: pkg(scripts), ...(file !== "package.json" && { extra: { [file]: text } }) });
        const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath, minDensity: 0, ignore: ["^graph\\.json$"] });
        expect(sel.kind).toBe("all");
      });
    }

    it("still fails open on a dependency change", () => {
      const { repo, graphPath } = range({ pkg: pkg({ test: "vitest run", "docs:check": "x" }, "15.1.0") });
      const sel = runSelection({ repo, range: "HEAD~1..HEAD", graphPath, minDensity: 0, ignore: ["^graph\\.json$"] });
      expect(sel.kind).toBe("all");
    });
  });
});
