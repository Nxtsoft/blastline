# blastline

Graph-backed test impact and blast radius for CI and PRs, built on [CGraph](https://github.com/taylor009/CGraph).

**Status: pre-release scaffold.** The pipeline is specified but not yet implemented — see [the proposal](openspec/changes/bootstrap-blastline/proposal.md) for the full design, scope, and phased plan. What exists today: the diff parser (`src/diff.ts`, tested) and the CLI shell.

## What it will do

One pipeline — `git diff base..head` → changed graph nodes → transitive dependents via CGraph's `impact` query → intersect with the test-node set — behind three surfaces:

- **CLI**: `blastline tests base..head` (impacted test list for any runner), `blastline blast base..head` (dependents with file:line)
- **GitHub Action**: a PR comment showing real downstream dependents and impacted tests
- **MCP server**: `blastline_tests` / `blastline_blast` so coding agents can pre-flight their own edits

Selection is a **safe superset** ("run at least these"), deterministic, and fails open to a full run — with a printed reason — whenever the graph can't vouch for the diff (config/lockfile changes, unresolved imports, a stale graph). Every CI selection pins CGraph's content-root freshness proof, so it carries evidence of exactly which source tree it was computed from.

## v1 scope

TypeScript repos, Vitest/Jest, GitHub Actions. Python and Go follow — CGraph already extracts them; only test detectors and runner adapters are new.

## Development

```sh
bun install
bun run build
bun run test
```

MIT.
