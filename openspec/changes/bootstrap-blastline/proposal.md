# Proposal: blastline — graph-backed test impact and blast radius for CI and PRs

Name: **blastline** (CLI `blastline`). Chosen 2026-08-18 after availability checks: `blastline` was free on npm (registry 404) and as Nxtsoft/blastline on GitHub; bare `reach` was taken on npm and weak for search. Runner-up `testreach` (also free) names only the test-selection half of the product.

## Why

Three findings converge (research, 2026-08-18):

1. **The market hole is confirmed.** No maintained, cross-language, build-system-agnostic, static-graph test-impact tool exists in open source. Incumbents are build-system-locked (bazel-diff, Nx/Turborepo `affected`), single-language coverage-based (pytest-testmon, Skippy), or closed SaaS (Meta PTS, Launchable/CloudBees, Gradle Develocity, Datadog TIA). The only open attempt at the general tool (`testless`) has 3 stars. The gap has been documented since Fowler's 2017 test-impact-analysis article and is still open in August 2026.

2. **The pain is loud and growing.** Agent-era metrics: change-failure rate up ~30%, incidents/PR up 23.5% (Cortex 2026), agent PR review volume up 10x YoY (GitHub), and "blast-radius blindness" has produced at least one venture-backed closed competitor (Riftmap) and one enterprise beta (Qodo Cross Repo Review).

3. **CGraph deliberately left this layer vacant.** `typed-explain-traversal/proposal.md:55` — "No test-impact prediction, change planning, or ownership/hotspot signals — those compose on top of this primitive in a later change." The agent-primitives research brief places test-impact prediction in "the agent (or a thin host skill)... they need a model and don't belong in the keyless binary." Blastline is that composition layer, as its own project.

Strategically, Blastline is also CGraph's distribution channel: every PR comment it posts is a public demonstration of a CGraph impact query, the way `nx affected` sells Nx.

## What it is

One core pipeline, three delivery surfaces.

**Pipeline:** `git diff base..head` → changed files/lines → changed graph nodes (via CGraph's node spans) → transitive dependents (`impact`, direction: dependents) → intersect with the test-node set → impacted tests + blast-radius report.

**Surfaces:**
1. **CLI** — `blastline tests base..head` prints the impacted test list (newline/JSON) for piping into any runner; `blastline blast base..head` prints the full dependent set with file:line.
2. **GitHub Action** — on every PR: a comment listing real downstream dependents of the diff and the impacted tests, plus a check output other jobs can consume to run only those tests.
3. **MCP server** — `blastline_tests` / `blastline_blast` tools so a coding agent can pre-flight its own edit before opening the PR.

## Selection semantics: safe superset, honestly stated

Static reachability misses dynamic dispatch, reflection, and runtime wiring — CGraph's own design-decisions doc concedes "some edges are approximate." Blastline therefore never claims "these are the only tests that matter." Its contract is:

- **"Run at least these"** — the impacted set is a floor, not a ceiling, for gating decisions made by the consumer.
- **Fail open to full-run.** Any of the following forces `ALL` (with a stated reason): changed files with no graph node (configs, lockfiles, build scripts, assets), unresolved imports touching the diff, a stale graph (see freshness), an extraction warning on a changed file, or a diff above a configurable size threshold.
- **Determinism.** Same repo state + same diff → byte-identical selection. No ML ranking in v1; that is what keeps the output auditable and CI-cacheable.

## Contract with CGraph (consumes, never forks)

Blastline is a downstream consumer of stable CGraph surfaces; it requires **zero CGraph engine changes** for v1:

1. **`graph.json` node-link export** (one-shot `cgraph --root . --out`) — the CI path. Nodes carry `source_file` + `source_location` spans; diff lines map to smallest containing node, the same resolution rule the seam spec uses.
2. **Daemon read ops** (`impact`, `explain`, `query` via `cgraph-client` / MCP) — the local/agent path, ~10ms warm.
3. **Content-root freshness pinning** — CI resolves `freshness.content_root` after build and pins `expected_content_root` on every read, so a selection can never silently come from a graph that doesn't match the checked-out SHA. This is a differentiator no incumbent has: the selection ships with a proof of what source it was computed from.
4. **Op-stats ledger** — Blastline's queries land in the ledger like any client's, so `cgraph stats` measures Blastline adoption for free.

Nice-to-have upstream asks (not blockers, filed as CGraph issues if v1 confirms need): packaged release binaries (README: "no packaged release yet — you build from source"), and Linux CI-friendly one-shot build performance (cold build ~76s on CGraph itself, dominated by serial sha256 per `persist-incremental-index/tasks.md:55` — cacheable around, see Design).

## New work Blastline owns (the graph does not do this today)

1. **Test-node classification.** Deciding which graph nodes are tests. v1: per-framework detectors combining file conventions (`*.test.ts`, `*.spec.ts`, `__tests__/`) with call-pattern confirmation (`describe`/`it`/`test` call edges already present in the graph). Pluggable detector interface from day one.
2. **Diff-to-node mapping.** Parse unified diff, map changed line ranges to smallest containing non-file node per changed file; deleted-node handling (map to the node's dependents in the *base* graph).
3. **Runner adapters.** v1 ships one: Vitest/Jest (`blastline tests | xargs vitest run`  and a documented `--related`-style recipe). Adapter interface for pytest/go test later.
4. **The Action.** Graph build (or cache restore) → selection → PR comment + `affected-tests` output. Comment format is the marketing surface; it must show file:line dependents, not just a test list.

## v1 scope (deliberately small)

- **One language: TypeScript** (largest agent-coding audience; strongest existing CGraph extraction; Vitest/Jest are the dominant runners).
- **One CI: GitHub Actions.**
- **Both query paths:** one-shot `graph.json` (CI) and daemon (local/MCP).
- **License: MIT** (matches CGraph's positioning against closed incumbents).

### v1 non-goals (each a recorded follow-up)
- Other languages' test conventions (Python/Go next — extraction already exists in CGraph; only detectors + adapters are new).
- ML/predictive ranking of the impacted set (Meta-PTS-style). Deterministic superset first; ranking only ever as an ordering hint, never as a skip decision.
- Cross-repo selection via seam graphs (natural v3; consumes `cgraph seam` fragments).
- Flaky-test detection, coverage collection, test sharding/scheduling.
- The agent claim verifier (`blastline check "no-other-callers X"`) — designed-for but v2; it reuses the same query layer.
- GitLab/other CI surfaces.

## Design sketch

```
blastline tests <base>..<head>
  1. git diff --unified=0 base..head          (pure git, no checkout mutation)
  2. load graph:  daemon (local)  |  cgraph-out/graph.json (CI)
     - CI cache: actions/cache keyed on content_root; miss -> one-shot cgraph build
  3. verify freshness: expected_content_root == HEAD tree hash, else rebuild
  4. changed nodes = smallest containing node per changed span (base + head graphs)
  5. impacted = union impact(node, direction=dependents) for changed nodes
  6. tests = impacted ∩ test-node set (detector output, cached per graph)
  7. emit: list | JSON | GitHub Action outputs | PR comment markdown
  fail-open rules evaluated at steps 2-6; reason always printed
```

Implementation language: **TypeScript** (npm distribution, Action runtime, and the v1 audience are all TS; Blastline is a thin orchestrator — the heavy lifting stays in the native CGraph binary).

## Prior art to study before building

- `sdsrss/code-graph-mcp` (66 stars) — an MCP server whose blast-radius pitch already includes test-risk phrasing ("78 tests at HIGH risk"). Small, but the closest conceptual overlap; differentiate on determinism, freshness proofs, CI/Action surface, and fail-open selection semantics rather than on the MCP tool alone.
- Riftmap (closed) and Qodo Cross Repo Review (beta; non-directional associations) — the commercial framing to position against: Blastline is open, deterministic, directed-edge, and self-hosted.
- ETH Zurich "Evaluating AGENTS.md" (arXiv 2602.11988): LLM-generated context files reduce task success ~3% while inflating cost 20%+ — citable evidence that prose context files don't substitute for structural queries; useful in the launch post.

## Risks

- **Approximate edges → missed tests.** Mitigated by fail-open rules + superset framing; measured by a benchmark harness (run Blastline's selection vs full suite on real repos' historical PRs, count escaped failures) before any "safe to gate on" claim is published.
- **CI cold build cost.** 76s-class builds are fine cached, painful uncached; the cache-by-content-root design and an honest "first run is slow" doc line handle v1. Upstream parallel-hash work is the real fix if adoption demands it.
- **CGraph packaging.** No release binaries today; the Action must build-from-source or vendor a prebuilt binary. This is the largest practical friction and the first upstream ask.
- **Name collision check** before announcing (npm, GitHub, crates).

## Success criteria (v1 = done when)

1. On a real TS repo (target: one of the Turing TS repos + one public OSS repo), `blastline tests` selects a strict subset for a typical PR and the subset contains every test the full run fails — demonstrated on ≥20 historical PRs.
2. The GitHub Action posts the blast-radius comment on a live PR end-to-end from a cold runner in under 5 minutes (cached: under 1 minute).
3. An agent (Claude Code) calls `blastline_tests` over MCP and runs only the returned tests, end-to-end.
4. Selection is byte-identical across two runs on the same commit pair.

## Task phases

1. **Spike (1-2 days):** diff→node mapping + impact intersection against CGraph's own graph.json on a TS fixture repo; validate the smallest-containing-span rule on real diffs.
2. **Core CLI:** pipeline, fail-open rules, freshness pinning, JSON/list output, Vitest/Jest detector.
3. **Benchmark harness:** historical-PR replay; publish the escaped-failure numbers (the honesty artifact — this is the CGraph-blog-style proof post).
4. **GitHub Action:** cache strategy, comment renderer, outputs contract.
5. **MCP server** + agent workflow doc.
6. **Launch:** repo under NxtSoft org, README with the benchmark numbers, blog post on open.nxtsoft.io, X/LinkedIn.
