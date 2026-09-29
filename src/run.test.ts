import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
