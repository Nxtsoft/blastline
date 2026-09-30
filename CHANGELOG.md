# Changelog

## 0.18.0

A `package.json` change that only adds scripts no longer runs the full suite.

- `inertScriptAddition` in `src/manifest.ts` reads a changed manifest at the range's base and head. It qualifies when the parsed manifest is identical (formatting only), or when every key outside `"scripts"` and every existing script are unchanged and each new script is neither a lifecycle or host hook (`pre*`, `post*`, `prepare`, `test`, `build`, `vercel-build`, ...) nor named by a non-code file outside Markdown: a workflow, a Makefile, an existing script, or a line keyed by it such as a turbo pipeline. A comment naming it is ignored; a code line naming it (a helper spawning `bun run docs:check`, a usage message) is walked like a changed line, so its tests are selected.
- A qualifying manifest with no code naming its scripts is skipped like an ignored file, with its own row ("only adds scripts nothing runs: …"); one with code readers is walked from those lines, and its row says so. Anything else, and anything unparseable, a supplied diff or a three-dot range, fails open as before.
- On a real web-app PR adding two scripts beside the tool they run, the run goes from all 395 test files to 1 (the tool's own test). Replayed over the 30 recorded full-suite PRs: all 30 verdicts unchanged (their manifest changes are dependency bumps or script edits, which still fail open).

## 0.17.1

The reader advice names the readers, not every module beside them.

- A folder mention is followed segment by segment while it agrees with the file's path, and stops counting the moment it turns off: `@/lib/upload/grid` no longer counts as a way to `lib/upload/testdata/x.csv`. Before, only the first segment after the folder was checked, so every module importing a sibling was listed; on a real web-app PR a new test fixture listed 36 readers reaching 26 tests, now 13 reaching 11, with the test that loads it first.
- Readers are ordered by evidence (named outright, then Spring profile and context, then path pieces), and the table shows the caveat that can hide tests (config that changes how tests run, a profile activated elsewhere) before noise.
- A template or glob segment (`${kind}`, `*`) stands for one path component and the comparison continues past it; only `**` matches any depth. Before, any template counted at once, so every route under a Next.js `[uuid]` folder was a reader: on an app-router fixture, 227 readers become 27.
- Whether a file walks directories is read only when a mention could count: never for a bare word (`new` in `new Map()`). Before, every file mentioning a parent folder was read: 5,000 `git show` calls and 32 seconds on a 5,000-file probe that found nothing; on the app-router fixture, 1,478 reads and 14 seconds become 235 and 3.
- The shown caveat puts a truncated walk ("exceeded the traversal budget", "go deeper than") with the ones that can hide tests. `\bglob` no longer matches `globalThis`. `.gitignore` ignores a symlinked `node_modules`.

## 0.17.0

Under a full-suite verdict, the comment says which code reads each unmapped file and which tests those readers reach. Advice only: the verdict never changes.

- `resolveReferences` in `src/references.ts` finds readers at the range's head: a non-comment line naming the file (directives such as `#include`, `//go:embed`, `/// <reference>` and Rust `#[...]` count); a piece a path can be built from (the stem in quotes, the file's folder used as a path, a higher folder in a file that walks directories, a directory walk over its extension); and, in a Spring repository, context tests for `application.yml` or code naming, templating or activating the profile for `application-<p>.yml`, with subclasses and meta-annotated classes followed. A non-code reader is followed to the code that names it; lockfiles and repository metadata (`.github/dependabot.yml`, `CODEOWNERS`) never read anything.
- `unmapped-file` gains `readers`, `readerTests` (the test files the readers reach, each reader seeded at the innermost symbol around its naming lines via `seedLines`, now shared with changed lines) and `caveats` (build or CI config mentioning it, activation by expression, a reader reaching no test, a non-code reader nothing runs, no code reads it).
- The unmapped block renders a table per file (readers, tests reached, first caveat) and the reached tests behind a fold.
- A first version let these readers replace the full suite. An independent review built probes where it silently dropped real tests (pytest fixtures, `@SpringBootTest` base classes and meta-annotations, paths built from a stem, `os.ReadDir`, profiles activated by constants), and the version strict enough to be safe vouched for none of 30 real full-suite PRs. So it ships as advice. Replayed over those 30 PRs: verdicts identical to 0.16.0 on all 30; 17 of the 29 full-suite PRs get a reader table.

## 0.16.0

The full-suite comment says which unmapped files nothing names, and gives their `ignore` patterns.

- `unnamedFiles` in `src/unnamed.ts` runs one case-insensitive `git grep -F` at the range's head for each unmapped file's basename and the name of every folder above it (loaders walk folders: a `fixtures` glob, `WalkDir("testdata")`), outside Markdown and outside the file itself; a file nothing names gets `unnamed: true` on its `unmapped-file` reason (in `--json` and over MCP too). Files that affect tests without being named are never marked: Spring `application*`/`bootstrap*`/logging config, `src/*/resources/**`, `META-INF/`, snapshots and `testdata`/`fixtures`/`golden` folders, manifests and lockfiles across ecosystems, build files (`Makefile`, `build.rs`, Gradle), test-runner and toolchain config (`.babelrc*`, `jest.config.*`, `phpunit.xml`, `rust-toolchain`, `.cargo/`, …), `.env*` other than templates.
- The unmapped block lists them as anchored, escaped regexes to add under the workflow's `ignore: |`, up to 20. Selection is unchanged: the run still fails open, and nothing is ignored until someone pastes the pattern.
- The search runs after selection and outside the graph's `try`, so a failed search drops only the suggestion (with a stderr line) and is never reported as an unreadable graph.
- Replayed over the 30 full-suite PRs in six repositories running Blastline, each at its PR head: 6 of 90 unmapped entries offered, on three PRs of one Spring service (production and local-dev compose files, `.env.example`), none read by a test.

## 0.15.0

The brief reads Entire's branch backend, and the Intent cell says what the agent said, not who signed the commit.

- A commit whose `Entire-Checkpoint:` trailer carries a 12-character id (Entire's branch backend, the default for a repository enabled before 0.10.0) is resolved to `<first two>/<rest>/` on the branch `entire/checkpoints/v1`, read from the local branch or origin's; the Action fetches that branch beside the per-checkpoint refs. Before, the trailer did not match, and every such commit fell through to `claude-code by Co-authored-by`: on Turing-Labs-AI/turing-webapp PR 621, ten of twelve commits, each with a full checkpoint on the remote.
- The Intent cell shows the first line of the agent's first text in the turn that produced the commit and, when it differs, its last (`then: …`), then the agent and model. The branch backend snapshots one cumulative transcript per session and each snapshot is a prefix of the next, so a commit's part is the lines after the previous checkpoint of the same session in the range (skipped only when this transcript's first lines hash to that snapshot, so `blastline checkpoint write`'s one-transcript-per-commit refs are read whole); `windowsOf` in `src/checkpoint.ts` starts the cell's window at the later of that and the last prompt a person typed before the first tool call that works on one of the commit's files (an edit tool by path, a `Bash` command by basename). The test commands, and so the reaching tests that ran, come from that whole turn, so every commit a turn makes after its test run carries the run. A commit whose window holds nothing says `same step as <sha>`. The Ran before push cell names the runners and counts instead of the commands, which carry machine paths; a multi-line command used to break the table.
- `promptLine` skips a prompt the harness delivered (a block starting with `<`, such as `<task-notification>`, or a skill's instructions) and the `---` separators Entire writes between a turn's prompts, so the fallback prompt is the first line a person typed. On an orchestrated session it used to be `<task-notification>`.
- `Checkpoint` gains `narration` (`started`, `ended`, `texts`, `tools`), `sessions` (`id`, `lines`, `hash`) and `sameStepAs`; `checkpointFor` takes what earlier checkpoints read per session and the commit's files. The footer's unread-checkpoint line names the push that brings a missing checkpoint: the refs, or the branch.

## 0.14.8

A path in code font matches a changed line whole, not as a substring.

- 0.14.7 let `lib/index.ts` count as carried by a line containing `somelib/index.tsx`, so a phantom path could read as consistent. The match now requires a boundary on both sides, the way a symbol token already did (a leading `/` is allowed, matching how a changed path is compared). Found in review of #45.

## 0.14.7

The narrative check no longer calls a machine path or a file type a phantom change.

- A name in code font that starts with `/` or `~` (`/Applications`, `~/Applications/Passless.app`) or is a bare extension (`.pkg`) is not a claim about the diff: it names a place on a machine or a kind of file. `codeNames` in `src/brief.ts` skips them.
- A repo-relative path in code font is carried by the diff when any changed line contains it, so `./lib.js` in an added import is consistent, not refuted. Before, a path was matched only against the changed files.
- On a packaging-script PR whose body described the install location and the built artifact, six refuted claims become two: the path the installer wrote to outside the repo, and the file inside the built package the body compared.

## 0.14.6

The Reviewed-by row names what the change reaches that its own humans have never touched.

- When the range has human-authored commits (by git name, agent-authored ones set aside), the row adds `<names> has no prior commit in N of the M files this change touches or reaches: …`, from the same history the owners come from; files the range adds are not counted. `unfamiliarTo` in `src/owners.ts`; `review.unfamiliar` in `--json`; `owners.perFile` lists each file's human authors.
- Absent when the range has no human-authored commit to name, or when every file has one of theirs.
## 0.14.5

The brief names the other open PRs it meets, before merge time does.

- A **Concurrent PRs** Summary row: each open PR whose brief meets this one, with what it changes that this PR's code reaches (the changed symbols named), files both change, and what this PR changes that its code reaches. `concurrentPrs` in `src/brief.ts` intersects the snapshots; `brief.concurrent` in `--json`.
- The snapshot every brief embeds now carries `changed` (the mapped changed files) and `symbols` (`path:label` from change-context), so the next brief on any PR can meet it. A brief older than 0.14.5 has no changed set and is skipped.
- `blastline brief --others <file>` (`[{number, body}]`, the other PRs' brief comments); `others` on `blastline_brief` over MCP; the Action collects the newest 30 open PRs' briefs with the token it has. Without it the footer says so; with it and no meeting point, the footer says how many briefs were read. `--pr` keeps this PR's own brief out of the comparison; the snapshot embeds at most 200 symbols.

## 0.14.4

The per-file table says why each changed symbol changed, in the agent's own words.

- A **Why** column in "What each changed file reaches", present when a checkpoint carries a reason: for each changed symbol the brief knows from change-context, the first line of the agent's last text before the edit that touched it, with the turn (`turn 7: Map the labels back before matching`), at most two distinct lines per file. Reviewers of agent code reconstruct intent rather than check against it (Agarwal, Miller, Kastner, Vasilescu 2026); this puts the intent at the granularity they read.
- `src/checkpoint.ts` gains one allowlisted field, `reasons`: `symbolReasonsIn` matches the compact transcript's `Edit`, `Write` and `MultiEdit` calls to the symbols by file and by name (a `Write` touches every symbol in its file), and keeps only the capped first line of the preceding text. The edit's contents are searched and never shown; `checkpointFor(repo, commit, symbols)` takes the symbols to look for.
- On the agent machine, `blastline brief --local` reads the same from the fleet index's `tool_calls`, with the narration step covering the edit as the reason.

## 0.14.3

The brief says who has looked at the change and who knows the code it reaches.

- A **Reviewed by** Summary row: every reviewer other than the author with their latest state, or `no reviewer other than the author (login) so far`; and the humans whose commits last changed the changed and reached files before this range, most commits first. `src/owners.ts` reads that history in one `git log` up to the base and sets aside the commits an agent authored (a vendor address as the author, or Copilot's `Agent-Logs-Url:` trailer); a human's commit with an agent co-author or a checkpoint is the human's.
- `blastline brief --author <login> --reviews <file>` (GitHub's reviews API body or `[{login, state}]`); `author` and `reviews` on `blastline_brief` over MCP; the Action passes the PR author and fetches its reviews with the token it has. Without `--reviews` the row names owners only and the footer says so.
- `brief.review` in `--json`: `{author, reviews, owners: {files, commits, agentCommits, authors: [{name, commits, files}]}}`; `reviews` is absent when none were fetched, and the row then says nothing about who has looked.

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
