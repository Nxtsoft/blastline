import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexGraph, loadGraph } from "./graph.js";
import { mapDiffToSeeds } from "./mapping.js";
import type { ChangedFile } from "./types.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));
const g = loadGraph(FIXTURE);

const change = (path: string, start: number, end: number, deletion = false): ChangedFile => ({
  path,
  oldPath: path,
  status: "modified",
  ranges: [{ start, end, deletion }],
});

describe("mapDiffToSeeds", () => {
  it("picks the innermost symbol per line", () => {
    // Line 10 sits inside both parse [3-20] and innerHelper [8-12].
    const { seeds, failOpen } = mapDiffToSeeds(g, [change("src/lib.ts", 10, 10)]);
    expect(failOpen).toEqual([]);
    expect(seeds).toEqual(new Set(["fn_inner"]));
  });

  it("seeds every symbol for a whole-file range (spike defect regression)", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 1, 30)]);
    expect(seeds).toContain("fn_parse");
    expect(seeds).toContain("fn_inner");
    expect(seeds).toContain("fn_other");
    expect(seeds).toContain("f_lib"); // lines 1-2 and 21 fall outside symbols
  });

  it("falls back to the file node for lines outside every symbol span", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 21, 21)]);
    expect(seeds).toEqual(new Set(["f_lib"]));
  });

  it("fails open on files with no graph node", () => {
    const { seeds, failOpen } = mapDiffToSeeds(g, [change("README.md", 1, 5)]);
    expect(seeds.size).toBe(0);
    expect(failOpen).toEqual([{ kind: "unmapped-file", path: "README.md" }]);
  });

  it("skips ignored files entirely instead of failing open", () => {
    const { seeds, failOpen } = mapDiffToSeeds(g, [change("README.md", 1, 5)], {
      ignore: (p) => p.endsWith(".md"),
    });
    expect(seeds.size).toBe(0);
    expect(failOpen).toEqual([]);
  });

  it("maps pure deletions via the base graph when supplied", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 9, 9, true)], { baseGraph: g });
    expect(seeds).toEqual(new Set(["fn_inner"]));
  });

  it("degrades pure deletions to the head file node without a base graph", () => {
    const { seeds } = mapDiffToSeeds(g, [change("src/lib.ts", 9, 9, true)]);
    // Old-side line numbers are meaningless against the head graph; the file
    // node is the documented superset-safe approximation.
    expect(seeds).toEqual(new Set(["f_lib"]));
  });

  it("seeds all base symbols for a deleted file, and fails open without them", () => {
    const deleted: ChangedFile = {
      path: "src/lib.ts",
      oldPath: "src/lib.ts",
      status: "deleted",
      ranges: [{ start: 1, end: 30, deletion: true }],
    };
    const withBase = mapDiffToSeeds(g, [deleted], { baseGraph: g });
    expect(withBase.seeds).toContain("fn_parse");
    expect(withBase.seeds).toContain("fn_other");
    const withoutBase = mapDiffToSeeds(g, [deleted]);
    expect(withoutBase.failOpen).toEqual([{ kind: "unmapped-file", path: "src/lib.ts" }]);
  });
});

// A CMakeLists has no graph node, so touching one used to fail the whole
// selection open — which made selection blind on exactly the PRs that ADD
// tests, since registering a test means editing the file that declares it
// (issue #22). A purely additive registration hunk is not opaque: it names the
// tests that appeared, and their sources seed the walk.
describe("mapDiffToSeeds: files loaded by convention", () => {
  // The shape cgraph bin-v0.9.4 gives a Spring service: application.yml has a
  // file node and an Actuator child, build.gradle.kts a file node, and a
  // controller test depends on the Actuator node.
  const spring = indexGraph(
    [
      { id: "f_app_yml", label: "application.yml", type: "file", source_file: "core/src/main/resources/application.yml" },
      { id: "actuator_exposure", label: "actuator_exposure", type: "config", source_file: "core/src/main/resources/application.yml", source_location: { start_line: 3, end_line: 6 } },
      { id: "f_gradle", label: "build.gradle.kts", type: "file", source_file: "core/build.gradle.kts" },
      { id: "f_health_test", label: "HealthTest.kt", type: "file", source_file: "core/src/test/kotlin/HealthTest.kt" },
      { id: "fn_health", label: "health", type: "function", source_file: "core/src/main/kotlin/Health.kt", source_location: { start_line: 1, end_line: 10 } },
    ],
    [{ source: "f_health_test", target: "actuator_exposure", relation: "references" }],
  );

  it("fails open on application.yml even though the graph has nodes for it", () => {
    const { seeds, failOpen } = mapDiffToSeeds(spring, [change("core/src/main/resources/application.yml", 4, 4)]);
    expect(seeds.size).toBe(0);
    expect(failOpen).toEqual([{ kind: "unmapped-file", path: "core/src/main/resources/application.yml", convention: true }]);
  });

  it("fails open on a Gradle build file that has a file node", () => {
    const { seeds, failOpen } = mapDiffToSeeds(spring, [change("core/build.gradle.kts", 12, 12)]);
    expect(seeds.size).toBe(0);
    expect(failOpen).toEqual([{ kind: "unmapped-file", path: "core/build.gradle.kts", convention: true }]);
  });

  it("marks nothing as convention when the graph has no node for the file", () => {
    const { failOpen } = mapDiffToSeeds(spring, [change("core/src/main/resources/application-dev.yml", 1, 1)]);
    expect(failOpen).toEqual([{ kind: "unmapped-file", path: "core/src/main/resources/application-dev.yml" }]);
  });

  it("fails open when a file is renamed away from a convention name", () => {
    const renamed: ChangedFile = { ...change("core/src/main/resources/settings.yml", 1, 1), oldPath: "core/src/main/resources/application.yml", status: "renamed" };
    const { failOpen } = mapDiffToSeeds(spring, [renamed]);
    expect(failOpen).toEqual([{ kind: "unmapped-file", path: "core/src/main/resources/application.yml" }]);
  });

  it("still maps ordinary code beside a convention file", () => {
    const { seeds, failOpen } = mapDiffToSeeds(spring, [change("core/src/main/resources/application.yml", 4, 4), change("core/src/main/kotlin/Health.kt", 5, 5)]);
    expect(failOpen).toHaveLength(1);
    expect(seeds).toEqual(new Set(["fn_health"]));
  });

  it("leaves a convention file to `ignore` when the workflow declares it", () => {
    const { failOpen } = mapDiffToSeeds(spring, [change("core/build.gradle.kts", 1, 1)], { ignore: (p) => p.endsWith(".kts") });
    expect(failOpen).toEqual([]);
  });
});

describe("mapDiffToSeeds: CMake test registration", () => {
  const cg = loadGraph(fileURLToPath(new URL("./testdata/cmake-graph.json", import.meta.url)));

  const cmakeChange = (added: string[], removed: string[] = []): ChangedFile => ({
    path: "tests/smoke/CMakeLists.txt",
    oldPath: "tests/smoke/CMakeLists.txt",
    status: "modified",
    ranges: [{ start: 100, end: 100 + added.length, deletion: false }],
    added,
    removed,
  });

  const REGISTER = [
    "add_executable(cgraph_import_disambiguation_test",
    "  import_disambiguation_test.cpp)",
    "",
    "target_link_libraries(cgraph_import_disambiguation_test",
    "  PRIVATE",
    "    cgraph::engine)",
    "",
    "cgraph_set_warnings(cgraph_import_disambiguation_test)",
    "add_test(NAME cgraph_import_disambiguation_test COMMAND cgraph_import_disambiguation_test)",
  ];

  it("seeds the declared test's sources instead of failing open", () => {
    const { seeds, failOpen } = mapDiffToSeeds(cg, [cmakeChange(REGISTER)]);
    expect(failOpen).toEqual([]);
    expect(seeds).toEqual(new Set(["f_new_test", "fn_new_test_main"]));
  });

  it("does not drag in tests it did not declare", () => {
    const { seeds } = mapDiffToSeeds(cg, [cmakeChange(REGISTER)]);
    expect(seeds).not.toContain("f_other_test");
    expect(seeds).not.toContain("fn_other_test_main");
  });

  it("still fails open when the hunk is not pure registration", () => {
    const withRemoval = mapDiffToSeeds(cg, [
      cmakeChange(REGISTER, ["target_compile_options(cgraph_engine PRIVATE -O2)"]),
    ]);
    expect(withRemoval.seeds.size).toBe(0);
    expect(withRemoval.failOpen).toEqual([
      { kind: "unmapped-file", path: "tests/smoke/CMakeLists.txt" },
    ]);
  });

  it("fails open when a declared source is absent from the graph", () => {
    // Registered but never extracted: seeding nothing would silently turn a
    // loud "run everything" into a quiet "run nothing".
    const unextracted = [
      "add_executable(ghost_test ghost_test.cpp)",
      "add_test(NAME ghost_test COMMAND ghost_test)",
    ];
    const { seeds, failOpen } = mapDiffToSeeds(cg, [cmakeChange(unextracted)]);
    expect(seeds.size).toBe(0);
    expect(failOpen).toHaveLength(1);
  });

  it("fails open when the registered source is not a test path", () => {
    const notATest = [
      "add_executable(helper_tool helper_tool.cpp)",
      "add_test(NAME helper_tool COMMAND helper_tool)",
    ];
    const { failOpen } = mapDiffToSeeds(cg, [cmakeChange(notATest)]);
    expect(failOpen).toHaveLength(1);
  });

  it("leaves non-CMake unmapped files alone", () => {
    const json: ChangedFile = {
      path: "package.json",
      oldPath: "package.json",
      status: "modified",
      ranges: [{ start: 1, end: 2, deletion: false }],
      added: ["add_executable(a_test a_test.cpp)", "add_test(NAME a_test COMMAND a_test)"],
      removed: [],
    };
    expect(mapDiffToSeeds(cg, [json]).failOpen).toEqual([
      { kind: "unmapped-file", path: "package.json" },
    ]);
  });

  it("fails open when the parser had no line contents to read", () => {
    const noContent: ChangedFile = {
      path: "tests/smoke/CMakeLists.txt",
      oldPath: "tests/smoke/CMakeLists.txt",
      status: "modified",
      ranges: [{ start: 1, end: 2, deletion: false }],
    };
    expect(mapDiffToSeeds(cg, [noContent]).failOpen).toHaveLength(1);
  });
});
