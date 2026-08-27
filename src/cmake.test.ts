import { describe, expect, it } from "vitest";
import { declaredTests, isCMakePath } from "./cmake.js";

/** The exact block CGraph adds for every new smoke test (CGraph#68/#69/#71). */
const REAL_BLOCK = [
  "add_executable(cgraph_import_disambiguation_test",
  "  import_disambiguation_test.cpp)",
  "",
  "target_link_libraries(cgraph_import_disambiguation_test",
  "  PRIVATE",
  "    cgraph::engine)",
  "",
  "cgraph_set_warnings(cgraph_import_disambiguation_test)",
  "cgraph_enable_sanitizers(cgraph_import_disambiguation_test)",
  "",
  "add_test(NAME cgraph_import_disambiguation_test COMMAND cgraph_import_disambiguation_test)",
  "",
];

describe("isCMakePath", () => {
  it("recognizes CMakeLists.txt and .cmake modules", () => {
    expect(isCMakePath("tests/smoke/CMakeLists.txt")).toBe(true);
    expect(isCMakePath("CMakeLists.txt")).toBe(true);
    expect(isCMakePath("cmake/helpers.cmake")).toBe(true);
    expect(isCMakePath("src/main.cpp")).toBe(false);
    expect(isCMakePath("docs/CMakeLists.txt.md")).toBe(false);
  });
});

describe("declaredTests", () => {
  it("reads the real CGraph registration block", () => {
    expect(declaredTests(REAL_BLOCK, [])).toEqual([
      {
        target: "cgraph_import_disambiguation_test",
        sources: ["import_disambiguation_test.cpp"],
      },
    ]);
  });

  it("reads two registrations in one hunk", () => {
    const added = [
      "add_executable(a_test a_test.cpp)",
      "add_test(NAME a_test COMMAND a_test)",
      "add_executable(b_test b_test.cpp)",
      "add_test(NAME b_test COMMAND b_test)",
    ];
    expect(declaredTests(added, [])?.map((t) => t.target)).toEqual(["a_test", "b_test"]);
  });

  // Everything below must fail open. A CMakeLists edit can change a compile
  // flag or a link library in ways that affect every target in the file, and no
  // line rule tells that apart from a registration — so anything the parser
  // cannot fully attribute to newly declared targets returns null.

  it("refuses when any line was removed", () => {
    expect(declaredTests(REAL_BLOCK, ["add_test(NAME old_test COMMAND old_test)"])).toBeNull();
  });

  it("refuses a command touching a target it did not declare", () => {
    const added = [
      "add_executable(a_test a_test.cpp)",
      "add_test(NAME a_test COMMAND a_test)",
      "target_compile_options(some_other_target PRIVATE -O3)",
    ];
    expect(declaredTests(added, [])).toBeNull();
  });

  it("refuses a bare directory-scoped command that names no target", () => {
    const added = ["add_compile_definitions(NDEBUG)", "add_executable(a_test a_test.cpp)", "add_test(NAME a_test COMMAND a_test)"];
    expect(declaredTests(added, [])).toBeNull();
  });

  it("refuses an add_test whose executable was not declared in the hunk", () => {
    expect(declaredTests(["add_test(NAME existing_test COMMAND existing_test)"], [])).toBeNull();
  });

  it("refuses the legacy positional add_test form", () => {
    const added = ["add_executable(a_test a_test.cpp)", "add_test(a_test a_test)"];
    expect(declaredTests(added, [])).toBeNull();
  });

  it("refuses a hunk with no add_test at all", () => {
    expect(declaredTests(["add_executable(a_lib a.cpp)"], [])).toBeNull();
  });

  it("refuses variable and generator expansions", () => {
    const added = [
      "add_executable(a_test ${TEST_SOURCES})",
      "add_test(NAME a_test COMMAND a_test)",
    ];
    expect(declaredTests(added, [])).toBeNull();
  });

  it("refuses a partial hunk with an unbalanced command", () => {
    expect(declaredTests(["add_executable(a_test", "  a_test.cpp"], [])).toBeNull();
  });

  it("refuses stray text outside a command", () => {
    const added = ["add_executable(a_test a_test.cpp)", "endif()", "some_bare_word"];
    expect(declaredTests(added, [])).toBeNull();
  });

  it("refuses an empty or whitespace-only hunk", () => {
    expect(declaredTests([], [])).toBeNull();
    expect(declaredTests(["", "   "], [])).toBeNull();
  });

  it("ignores comments and blank lines inside an otherwise clean block", () => {
    const added = [
      "# a new smoke test",
      "add_executable(a_test a_test.cpp)",
      "",
      "add_test(NAME a_test COMMAND a_test)  # registered",
    ];
    expect(declaredTests(added, [])?.map((t) => t.target)).toEqual(["a_test"]);
  });

  it("keeps a quoted source path whole", () => {
    const added = [
      'add_executable(a_test "sub dir/a_test.cpp")',
      "add_test(NAME a_test COMMAND a_test)",
    ];
    expect(declaredTests(added, [])?.[0]?.sources).toEqual(["sub dir/a_test.cpp"]);
  });
});
