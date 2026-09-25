# Changelog

## 0.14.4

The per-file table says why each changed symbol changed, in the agent's own words.

- A **Why** column in "What each changed file reaches", present when a checkpoint carries a reason: for each changed symbol the brief knows from change-context, the first line of the agent's last text before the edit that touched it, with the turn (`turn 7: Map the labels back before matching`), at most two distinct lines per file. Reviewers of agent code reconstruct intent rather than check against it (Agarwal, Miller, Kastner, Vasilescu 2026); this puts the intent at the granularity they read.
- `src/checkpoint.ts` gains one allowlisted field, `reasons`: `symbolReasonsIn` matches the compact transcript's `Edit`, `Write` and `MultiEdit` calls to the symbols by file and by name (a `Write` touches every symbol in its file), and keeps only the capped first line of the preceding text. The edit's contents are searched and never shown; `checkpointFor(repo, commit, symbols)` takes the symbols to look for.
- On the agent machine, `blastline brief --local` reads the same from the fleet index's `tool_calls`, with the narration step covering the edit as the reason.

## 0.14.2

The narrative is a claim the brief checks: the PR body and each commit message against the diff.

- `blastline brief --narrative <file>` (the Action passes the PR body; `narrative` over MCP): a name set in code font that no changed symbol bears, no changed path matches and no changed line contains is `refuted` as a phantom change; an empty body, a template line, `TODO`/`TBD`/`WIP`, or a `wip`/`fixup!` subject is `refuted` as placeholder text; a file with symbol changes that neither the body nor any message names is a `partial` "the narrative names the changed code" (understated scope). Fenced code, HTML comments and links are skipped; shas, versions, flags and ranges in code font are not names. `narrativeClaims` in `src/brief.ts`.
- A changed declaration (its declaring line removed and added, differently) with base-graph callers in files the diff does not touch is `partial`, never refuted. `changedDeclarationClaims` in `src/brief.ts`; the caller lookup is shared with the removed-symbol claim.
- Without `--narrative` the footer says only commit messages were read.

## 0.14.1

The per-file table says what to read first, and the Downstream row says how much reviewing the change asks for.

- A **Read** column leads the "What each changed file reaches" table: files in reach order (tests reached, then dependents), a changed file that another changed file reaches placed right after it as `with <file>`, test files last. Reviewers comment less on each file the further down a list it sits (Rahman, Codabux, Roy 2026), so the order carries the reach, not the alphabet. `readingOrder` in `src/comment.ts`.
- `| Downstream code | 4 files, 11 dependents · review effort medium |`: a coarse tier from what the graph measured (`high` from 20 dependents or 10 mapped files, `low` under 5 dependents and 4 files), fixed thresholds stated in the README. `reviewEffort` in `src/comment.ts`.
- Ignored rows gain an empty Read cell; nothing else in the comment or brief moves.

## 0.14.0

The Intent column no longer goes empty on a commit that carries no checkpoint but does carry the agent's own marks.

- `src/checkpoint.ts` reads a commit's provenance from the commit itself: Copilot's `Agent-Logs-Url:` trailer (the agent and a session-log link), and a vendor noreply address as the author or a `Co-authored-by:` (`noreply@anthropic.com` is claude-code, `copilot@users.noreply.github.com` is copilot, after lowercasing and dropping GitHub's `<id>+` prefix; the registry agent-change-control ships). Consulted only for a commit with no `Entire-Checkpoint:` trailer; a dangling trailer still reads "not fetched".
- The brief carries it as `commits[].provenance`; the comment renders `copilot by Agent-Logs-Url · session log` in the Intent column, counts the commit as an agent commit, says `N attributed by trailer` in the Intent row and footer, and the footer counts the commits with neither source and says which sources the run lacked (trailer, vendor address, session index).
- A mark makes no claim: no prompt, files or test commands, so nothing is refuted or called consistent on its account.

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
