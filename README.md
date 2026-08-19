# blastline

Graph-backed test impact and blast radius for CI and PRs, built on [CGraph](https://github.com/taylor009/CGraph).

**Status: pre-release; CLI, GitHub Action, and MCP server all work.** The selection pipeline (diff → graph nodes → transitive dependents → impacted tests, with fail-open rules) is implemented, unit-tested, and [benchmarked on historical commits](openspec/changes/bootstrap-blastline/bench-results.md) — see [the proposal](openspec/changes/bootstrap-blastline/proposal.md) for design. Remaining before launch: CGraph daemon freshness pinning (content-root proofs) and the fixes for CGraph issues [#39](https://github.com/taylor009/CGraph/issues/39)/[#40](https://github.com/taylor009/CGraph/issues/40).

```sh
# graph the repo once (CGraph), then select tests for a diff
cgraph --root ./src --out cgraph-out
blastline tests main..HEAD | xargs vitest run
blastline blast main..HEAD          # transitive dependents with file:line
```

Selection prints `ALL` (with machine-readable reasons on stderr) whenever the graph can't vouch for the diff — unmapped files, a graph older than the head commit, or an oversized diff. `--ignore <regex>` declares paths irrelevant (docs, content) so they don't force full runs; `--json` gives structured output.

## What it does

One pipeline — `git diff base..head` → changed graph nodes → transitive dependents via CGraph's `impact` query → intersect with the test-node set — behind three surfaces:

- **CLI**: `blastline tests base..head` (impacted test list for any runner), `blastline blast base..head` (dependents with file:line)
- **GitHub Action**: a PR comment showing real downstream dependents and impacted tests
- **MCP server**: `blastline_tests` / `blastline_blast` so coding agents can pre-flight their own edits

Selection is a **safe superset** ("run at least these"), deterministic, and fails open to a full run — with a printed reason — whenever the graph can't vouch for the diff (config/lockfile changes, unresolved imports, a stale graph). Every CI selection pins CGraph's content-root freshness proof, so it carries evidence of exactly which source tree it was computed from.

## v1 scope

TypeScript repos, Vitest/Jest, GitHub Actions. Python and Go follow — CGraph already extracts them; only test detectors and runner adapters are new.

## Use from a coding agent (MCP)

`blastline mcp` serves two stdio MCP tools — `blastline_tests` and `blastline_blast` — so an
agent can check what its edit reaches *before* opening a PR. Register it (Claude Code
`.mcp.json` shown; any MCP client works):

```json
{
  "mcpServers": {
    "blastline": { "command": "blastline", "args": ["mcp"] }
  }
}
```

The agent workflow: keep a CGraph graph warm for the repo (`cgraph --root ./src --out cgraph-out`,
or the CGraph daemon's persisted export), then before finalizing an edit call
`blastline_blast` with `repo` + `range` (or the pending `diff` text) to see every transitive
dependent with file:line, and `blastline_tests` to get the exact test files to run. A
`kind: "all"` answer means the graph can't vouch for the diff — run the full suite; the
`reasons` say why. Both tools accept `graph_path`, `ignore` regexes, and `min_density`.

## Development

```sh
bun install
bun run build
bun run test
```

MIT.
