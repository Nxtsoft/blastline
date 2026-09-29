# Proposal: offer the unmapped files nothing names as `ignore` patterns

## Why

Every "run the full suite" verdict in the last 60 PRs of six repositories that
run Blastline (a Spring service, three TypeScript apps, a mobile app and
CGraph) came from `unmapped-file`: 30 of 107 comments, 90 unmapped entries. The comment tells the
reader to "add a pattern for them to `ignore`" if the files cannot change which
tests should run, and leaves the reader to find out which ones those are by
grepping. People do it by hand after the fact (three of the six repositories
added such patterns in the same month), and one of those decisions was later
reversed because the file did feed tests (a lockfile).

The graph cannot answer "does anything read this file", but the repository can
answer the narrower question "does anything *name* it", cheaply, at the head of
the range.

## What Changes

- **`src/unnamed.ts` (new).** `unnamedFiles(git, rev, paths)` runs one
  `git grep -F` at the range's head (the working tree, untracked files included,
  when the diff was supplied as text) for each unmapped file's basename and the
  name of the directory it sits in, outside Markdown, and returns the files
  nothing but themselves names. The directory counts because loaders walk
  folders (`Files.list(migrations)`, `classpath*:migrations/*.cypher`) without
  naming any file in them. Whole lines are matched against every name, so one
  name cannot hide another it contains. A fixed never-list keeps out files that
  affect tests without being named: Spring `application*`/`bootstrap*`/logging
  config, `src/*/resources/**`, `META-INF/`, dependency manifests and lockfiles,
  Gradle wrapper and build files, test-runner and toolchain config, `.env*`
  (except `.example`/`.sample`/`.template`).
- **`src/types.ts`.** `unmapped-file` gains an optional `unnamed: true`.
- **`src/run.ts`.** `runSelection` marks the unmapped reasons after selection,
  outside the graph's `try`: a failed search is not a graph failure, and it
  costs only the suggestion (reported on stderr), never the verdict.
- **`src/comment.ts`.** The unmapped block lists the unnamed files as anchored,
  escaped regexes in a pasteable `ignore: |` fence, capped at 20.

Nothing about selection changes: an unnamed file still fails the run open, and
nothing is ever ignored without the reader pasting the pattern.

## Measured

Replayed over the 30 full-suite PRs at each PR's head commit: 7 of 90 unmapped
entries flagged, on three PRs of the Spring service (`docker-compose.prod.yml`,
`docker-compose.local-dev.yml`, `.env.example`, an openspec `.openspec.yaml`),
none of them a file any test reads. Every search took under 170 ms. The rule is
deliberately conservative: a folder name that appears in a CI script
(`workflows`) or a spec folder cited in a Kotlin comment suppresses the
suggestion, and a comment or log line that names a file counts as naming it.
