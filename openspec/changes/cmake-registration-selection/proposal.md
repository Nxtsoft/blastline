# Proposal: a CMake test registration selects the tests it declares (issue #22)

## Why

A build file has no graph node, so any diff touching one fails the whole
selection open with `unmapped-file`. That is right in general — nothing in the
graph can say what depends on a CMakeLists — but it makes selection blind on
exactly the pull requests that **add** tests, because registering a test means
editing the file that declares it.

Measured on our own dogfood loop (`Nxtsoft/CGraph`, every PR that has triggered
`test-impact.yml`): eleven PRs, six real subsets, five `ALL`. All five
fail-opens name `tests/smoke/CMakeLists.txt`, and **all five of those PRs added
a new test file.** The PRs most likely to be covering new behavior are exactly
the ones that got "run everything."

The tempting fix — adding the path to `ignore` — would be a lie of the kind the
ignore list exists to prevent: each regex asserts "changes here cannot affect
which tests should run," and editing the file that declares the tests is about
as relevant to test selection as a change can be.

## What Changes

- **`src/cmake.ts` (new).** `declaredTests(added, removed)` reads a purely
  additive CMake hunk as a set of newly registered test targets, or returns
  `null` meaning "fail open, as before." Accepted shape: at least one
  `add_test(NAME t ...)`, an `add_executable(t src...)` for every such `t`, and
  no other command that touches anything but those targets — which admits
  `target_link_libraries(t ...)` and project helper macros like
  `cgraph_set_warnings(t)` on the strength of naming a declared target first.
- **`src/mapping.ts`.** Before pushing `unmapped-file`, try that reading. The
  declared sources seed the walk like any other changed test file, so nothing
  downstream changes: no new `Selection` shape, no new fail-open reason, no new
  data path. Returns to the fail-open when *any* declared source is not a
  recognized test path or is absent from the graph — seeding nothing would turn
  a loud "run everything" into a quiet "run nothing".
- **`src/diff.ts` / `src/types.ts`.** The parser now retains verbatim `+`/`-`
  line contents per file (`added`, `removed`). Line ranges remain the mapping
  mechanism for everything the graph covers; contents exist only so a reader can
  understand a file the graph has no node for.

### Non-goals

- **Other ecosystems.** Gradle, Cargo, Maven and Bazel express this differently,
  and a half-supported matrix is worse than none. CMake ships alone, driven by a
  real repo, per issue #22's open question 3.
- **Removals and renames.** Any removed line fails open. Deleting an `add_test`
  retires a test, and selecting one that no longer exists is wrong; additive-only
  is the safe start (issue #22, open question 2).
- **The legacy positional `add_test(<name> <exe>)` form**, variable and
  generator expansions (`${...}`, `$<...>`), and any hunk the command parser
  cannot fully attribute. All fail open.

## Impact

Re-running every affected CGraph PR end-to-end, real diffs against real graphs:

| PR | new test registered | before | after |
|---|---|---|---|
| #62 | `rust_dispatch_test.cpp` | `ALL` | 15 tests |
| #64 | `rust_cfg_macro_test.cpp` | `ALL` | 27 tests |
| #68 | `java_dispatch_test.cpp` | `ALL` | 28 tests |
| #69 | `java_receiver_scope_test.cpp` | `ALL` | 29 tests |
| #71 | `import_disambiguation_test.cpp` | `ALL` | 20 tests |

The newly registered test is present in every one of those selections. Against a
76-test suite run over seven CI jobs, that is the difference between running
everything and running a fifth to a third of it.

No regression where the graph already worked: PR #66, which selected 20 tests
before, still selects the same 20 — byte-identical output.

- **Touches:** `src/cmake.ts`, `src/cmake.test.ts`, `src/mapping.ts`,
  `src/mapping.test.ts`, `src/diff.ts`, `src/diff.test.ts`, `src/types.ts`,
  `src/testdata/cmake-graph.json`, `README.md`.

## Capabilities

### Modified Capabilities
- Selection mapping — a recognized test-registration file is no longer opaque.
