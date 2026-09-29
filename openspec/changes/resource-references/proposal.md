# Proposal: a changed file with no graph node selects the code that reads it

## Why

Every "run the full suite" verdict in the last 60 PRs of six repositories
running Blastline came from `unmapped-file`: a changed config, data or build file
the graph has no node for. Many of those files are read by code that says so in
a string -- a test that opens `fixtures/rows.csv`, a migration test that walks
`migrations/`, a Spring test that loads `application-production.yml` -- so the
readers are knowable from the repository, and the tests that depend on them are
a far smaller set than the whole suite.

The hard part is completeness. Selection is a safe superset, so a file may be
resolved only when EVERY reader can be found; a missed reader is a test that
should have run and did not. Spring Boot is the sharp case: it loads
`application-{profile}.yml` for any run with that profile active, and no string
anywhere names the file.

## What Changes

- **`src/references.ts` (new).** `resolveReferences(git, rev, paths, ctx)` finds
  each unmapped file's readers at the range's head:
  - **name**: a non-comment line names the basename (case ignored);
  - **folder**: a file names a folder above it as a path component and
    enumerates a directory (readdir, glob, `Files.list`, `WalkDir`,
    `classpath*:`, `**/` ...);
  - **Spring**, in a repository using Spring: `application.yml` is read by every
    test that starts an application context; `application-<p>.yml` by code that
    names it, builds its name from the profile, or activates the profile.
  A reader with no graph node is followed to its own readers (depth 3) unless it
  can change how tests run (build, toolchain, test-runner or Spring config, a CI
  workflow); lockfiles are never readers. A file stays **unresolved** -- today's
  fail-open, now with a reason -- when it is loaded by convention, when opaque
  config names it, when a Spring `profiles` block or a CI workflow activates its
  profile, or when no code reads it at all.
- **`src/mapping.ts`.** A resolved file seeds, for each reader, the innermost
  symbol around each naming line (the same rule as a changed line, now shared as
  `seedLines`). A reader with no node fails open rather than seeding nothing.
- **`src/types.ts` / `src/select.ts`.** A new disposition, `referenced`, with
  `readers`; `unmapped-file` gains `unresolved` (why).
- **`src/run.ts`.** Resolves the changed files the graph has no node for before
  selection; a failed search costs only the resolution, never the verdict.
- **`src/comment.ts` / `src/brief.ts`.** A referenced file is a row with its
  readers and why each counts; per-commit reach, owners, the since-push snapshot
  and annotations treat it as a changed file. An unmapped file's list entry says
  why it stayed unresolved.

## Measured

Replayed over the 30 recorded full-suite PRs, each at its head with the
repository's own `ignore` list and `graph-root`, against a fresh cgraph graph,
on v0.16.0 and on this change: 9 become targeted and none regresses (no PR that
was a subset gets fewer tests or fails open). Examples: a migration change on a
Spring service goes from all 288 test files to 4 (the test that names it and the
two that walk the migrations folder); a migration-journal change on a TypeScript
API from 290 to 9; a CSS token change on a web app from 211 to 14. On the
motivating Spring PR, with the repository's current `ignore` list, a changed
`application-production.yml` selects 7 tests (both tests that load the file,
plus infrastructure code that sets the profile) and the PR runs 8 of 292.

The rest stay full-suite, mostly because the PR also changes a manifest or
lockfile (loaded by convention), or a file no code reads.
