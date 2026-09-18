import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDeliberatelyIgnored, loadPathVerdicts } from "./paths.js";

function fixture(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "blastline-paths-"));
  writeFileSync(join(dir, "graph.json"), "{}");
  if (contents !== undefined) writeFileSync(join(dir, "paths.json"), JSON.stringify(contents));
  return join(dir, "graph.json");
}

const VALID = {
  schema_version: 1,
  paths_are: "repo-relative",
  indexed: ["src/lib.py"],
  unindexed: ["CMakeLists.txt", ".github/workflows/ci.yml"],
  ignored_directories: ["research", "node_modules"],
  ignored_files: ["local.env"],
};

describe("loadPathVerdicts", () => {
  it("returns undefined when paths.json is absent", () => {
    expect(loadPathVerdicts(fixture(undefined))).toBeUndefined();
  });

  // A wrong verdict removes tests from the run, so an unrecognized schema is
  // treated as absent rather than guessed at.
  it("returns undefined for an unrecognized schema version", () => {
    expect(loadPathVerdicts(fixture({ ...VALID, schema_version: 99 }))).toBeUndefined();
  });

  it("returns undefined for malformed json rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "blastline-paths-"));
    writeFileSync(join(dir, "graph.json"), "{}");
    writeFileSync(join(dir, "paths.json"), "{ not json");
    expect(loadPathVerdicts(join(dir, "graph.json"))).toBeUndefined();
  });

  it("loads the verdict sets", () => {
    const v = loadPathVerdicts(fixture(VALID));
    expect(v?.ignoredDirectories).toEqual(["research", "node_modules"]);
    expect(v?.unindexed.has("CMakeLists.txt")).toBe(true);
  });
});

describe("isDeliberatelyIgnored", () => {
  const v = loadPathVerdicts(fixture(VALID));

  it("covers everything beneath an ignored subtree root", () => {
    // cgraph never walked these, so they are never listed individually --
    // matching by prefix is the only way to resolve them.
    expect(isDeliberatelyIgnored(v!, "research/evidence/result.json")).toBe(true);
    expect(isDeliberatelyIgnored(v!, "node_modules/dep/index.js")).toBe(true);
    expect(isDeliberatelyIgnored(v!, "research")).toBe(true);
  });

  it("matches an ignored file exactly", () => {
    expect(isDeliberatelyIgnored(v!, "local.env")).toBe(true);
  });

  // The load-bearing case: unindexed is NOT ignored. A build file that cgraph
  // could not extract may still change what a test means.
  it("never treats an unindexed file as ignored", () => {
    expect(isDeliberatelyIgnored(v!, "CMakeLists.txt")).toBe(false);
    expect(isDeliberatelyIgnored(v!, ".github/workflows/ci.yml")).toBe(false);
  });

  it("does not match a sibling whose name merely shares a prefix", () => {
    expect(isDeliberatelyIgnored(v!, "research-notes/x.md")).toBe(false);
  });

  it("does not treat an indexed file as ignored", () => {
    expect(isDeliberatelyIgnored(v!, "src/lib.py")).toBe(false);
  });
});
