# Changelog

## 0.13.2

- Action: `cgraph-version` defaults to `bin-v0.5.0`. Node ids are repo-relative in that release (Nxtsoft/CGraph #113), so a base graph and a head graph of the same tree share ids: verified on this repository's `src/` extracted from two roots of different depth, 545 of 545 ids identical, none carrying a root segment.

## 0.13.1

The fleet session index becomes a second checkpoint writer, and the brief can read it directly on the agent machine.

- `blastline checkpoint write [--commit <sha>] [--no-trailer] [--sessions-db <path>] [--json]`: binds the commit to the session that was working in the repository at that moment (agents-cli's `sessions.db`: cwd or worktree, the narration step covering the commit time, the test commands run in it) and writes an Entire-layout checkpoint ref (`source: "blastline"`) plus the `Entire-Checkpoint` trailer on an unpushed HEAD. A commit already carrying a trailer is left alone.
- `blastline brief --local` (and `local: true` on `blastline_brief`): a commit without a checkpoint ref takes its intent from the index; nothing is written and nothing leaves the machine.
- The checkpoint prompt line skips the `agents run` worktree preamble ("You are in a git worktree of …"), so an orchestrated agent's commit shows what the human asked, not the dispatch script.
- Reading Codex `exec` and Droid `Execute` tool calls as commands; a damaged or missing FTS table in the index no longer stops the brief.

## 0.13.0

The PR comment becomes a PR brief. Same marker, so an existing comment keeps updating in place.

- `blastline brief <base>..<head> [--change-context FILE] [--previous FILE] [--selection FILE] [--json] [--annotations N]`: the test-impact comment plus a per-commit table (intent from the commit's Entire checkpoint, files, reach, tests run before the push), a Symbols row and a Change column from `cgraph change-context`, a "since push" delta from the snapshot embedded in the previous comment, and a Claims checked list. `--json` prints `{brief, markdown, check_run}`.
- Claims are refuted, partial or consistent, never verified: a removed symbol against the base graph's static callers outside the diff, the reaching tests against the test commands the checkpoint ran, files touched against the commit.
- `src/checkpoint.ts` reads only the allowlisted subset of a checkpoint: id, commit, agent, model, first prompt line (200 characters), files touched, test-runner commands, source. The raw transcript is never read.
- `blastline_brief` MCP tool with the same inputs.
- Action: fetches `refs/entire/checkpoints/*`, defaults `cgraph-version` to `bin-v0.4.0` and runs `change-context` at budget 20000, renders the brief as the comment, and a new `check-run` input (default `true`) posts a `blastline` check run per head sha with up to 50 annotations on the highest-reach changed lines (`checks: write`).
- `vitest.config.ts` excludes `.agents/`, so worktrees under it are not run as this repository's tests.
