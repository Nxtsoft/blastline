# Proposal: a package.json change that only adds scripts is read, not refused

## Why

A manifest has no graph node, so a changed `package.json` fails the whole
selection open. In the earlier survey of 30 full-suite PRs, a manifest or
lockfile blocked 11. Most of those are dependency bumps, which rightly fail open.
One common shape does not need to: a PR that wires a new tool in with
`"docs:check": "bun run scripts/docs.ts check"` beside the tool and its test.
Nothing else changes about how any test runs, yet the whole suite runs.

## What Changes

- **`src/manifest.ts` (new).** `inertScriptAddition` compares the manifest at
  base and head. It qualifies a change that is formatting only, or that only
  adds scripts, where each new script is not a lifecycle or host hook and is
  named by no non-code file (outside Markdown). Code lines naming a new script
  are returned as readers; comments are ignored.
- **`src/run.ts`.** For a two-dot range, reads each modified `package.json` at
  both ends and searches for the new names once.
- **`src/mapping.ts` / `src/select.ts`.** A qualifying manifest with no readers
  is skipped like an ignored file, with a `why`; one with readers seeds the
  innermost symbol around each naming line (`readerNodes`). A reader the graph
  lost fails open.
- **`src/comment.ts`.** The proof is the manifest's row, and the summary counts
  such files apart from "ignored by policy".
- **`src/references.ts`.** Exports `isComment`.

## Measured

On a real web-app PR adding two scripts beside the tool they run: all 395 test
files to 1. Replay over the 30 recorded full-suite PRs: all verdicts unchanged.
