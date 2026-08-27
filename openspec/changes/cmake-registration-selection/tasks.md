# Tasks

## 1. Read a registration hunk
- [x] 1.1 `src/cmake.ts`: tokenize CMake text into complete `name(args...)`
      commands, refusing on unbalanced parens, stray words, or unterminated quotes.
- [x] 1.2 `declaredTests(added, removed)`: require ≥1 `add_test(NAME t ...)`, an
      `add_executable(t src...)` for each, and every other command's first
      argument to be a declared target. Return `null` otherwise.
- [x] 1.3 Refuse any removed line, and any `${...}` / `$<...>` expansion.

## 2. Retain line contents in the diff parser
- [x] 2.1 `ChangedFile.added` / `.removed`, optional so existing callers and
      hand-built fixtures keep compiling.
- [x] 2.2 Populate in `parseUnifiedDiff`, excluding the `+++`/`---` headers and
      preserving blank added lines as empty strings.

## 3. Wire it into mapping
- [x] 3.1 `registeredTestSeeds`: on an unmapped CMake file, seed the declared
      sources' nodes instead of failing open.
- [x] 3.2 Fail open when a declared source is not `isTestPath`, or has no node in
      the graph, or when the parser retained no contents.

## 4. Test
- [x] 4.1 `src/cmake.test.ts` — 15 cases, of which 10 are refusals (removals,
      undeclared targets, directory-scoped commands, legacy `add_test`,
      expansions, partial hunks, stray text, empty hunks).
- [x] 4.2 `src/mapping.test.ts` — 7 cases against a C++ fixture graph, including
      every fail-open path and "does not drag in tests it did not declare".
- [x] 4.3 `src/diff.test.ts` — contents captured, headers excluded, blank lines kept.
- [x] 4.4 Full suite green: 110/110.

## 5. Verify against the real repo
- [x] 5.1 Rebuild each affected CGraph PR's graph and re-run its real diff
      through both the current `main` and this branch.
- [x] 5.2 Confirm all five `ALL` outcomes become subsets, and that the newly
      registered test appears in each.
- [x] 5.3 Confirm no drift where the graph already worked (PR #66: byte-identical).
