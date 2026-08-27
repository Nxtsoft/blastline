<div align="center">

<img src="assets/hero.svg" alt="blastline — graph-backed test impact and blast radius" width="100%">

[![npm](https://img.shields.io/npm/v/blastline?style=flat-square&color=f5a651)](https://www.npmjs.com/package/blastline)
[![License: MIT](https://img.shields.io/badge/License-MIT-f5a651?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Nxtsoft/blastline/ci.yml?style=flat-square&label=CI)](https://github.com/Nxtsoft/blastline/actions)
[![selection escapes](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FNxtsoft%2Fblastline%2Fsafety-ledger%2Fbadge.json&style=flat-square)](https://github.com/Nxtsoft/blastline/actions/workflows/safety-audit.yml)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-59d499?style=flat-square)](https://modelcontextprotocol.io)
[![Built on CGraph](https://img.shields.io/badge/built%20on-CGraph-6ea8fe?style=flat-square)](https://github.com/Nxtsoft/CGraph)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-f5c451?style=flat-square)](#contributing)

*Diff in · impacted tests and blast radius out · deterministic, fail-open, served by a [CGraph](https://github.com/Nxtsoft/CGraph) code graph.*

</div>

## Contents

[Why blastline?](#why-blastline) ·
[How selection works](#how-selection-works) ·
[Benchmarks](#benchmarks) ·
[Quick start](#quick-start) ·
[GitHub Action](#github-action) ·
[Use with coding agents](#use-with-coding-agents) ·
[CLI reference](#cli-reference) ·
[Status & roadmap](#status--roadmap) ·
[Contributing](#contributing) ·
[License](#license)

## Why blastline?

Deciding which tests a diff needs means knowing what the change *reaches* — and that answer lives in the relationships between files, not in the diff. Every existing test-impact tool is locked to one build system (Bazel, Nx), one language via coverage instrumentation (pytest-testmon), or a closed SaaS. blastline computes it from a deterministic code graph instead, so it works on any repo CGraph can extract.

| | |
| --- | --- |
| 🎯 **Impacted tests, not guesses** | Changed lines map to graph symbols; a transitive-dependents walk finds every test that reaches them. `blastline tests main..HEAD \| xargs vitest run` runs exactly those. |
| 💥 **Blast radius on every PR** | The GitHub Action comments each PR with the change's transitive dependents, with `file:line` — the reviewer sees what the diff touches before reading it. |
| 🛡️ **Safe superset, fail-open** | The contract is "run *at least* these," never "safe to skip." Unmapped files, a stale graph, an under-extracted graph, or an oversized diff all fail open to a full run, with machine-readable reasons. |
| ⚡ **Deterministic & instant** | Selection is pure graph traversal: same repo state + same diff → byte-identical output, in under a millisecond on a built graph. No ML ranking, no coverage run. |
| 🤖 **Built for coding agents** | `blastline mcp` serves `blastline_tests` / `blastline_blast` / `blastline_check` over MCP, so an agent sees what its edit reaches — and what still references a symbol it's about to change — *before* opening the PR. |

> **The pitch in one line:** test-impact analysis is a graph-reachability problem — blastline is the reachability query, packaged as a CLI, a PR comment, and an MCP tool, with fail-open honesty when the graph can't vouch for a diff.

## How selection works

```
git diff --unified=0 base..head
   → changed line ranges                (src/diff.ts)
   → innermost graph node per line      (src/mapping.ts — whole-file adds seed every symbol)
   → transitive dependents walk         (src/impact.ts — CALLS, imports, re_exports, contains, inherits;
                                          dispatch barrier: interface contracts propagate to callers only)
   → intersect with test files          (src/detect.ts — JS/TS, pytest, Go, C/C++, Cargo, JVM conventions)
   → subset + blast radius, or ALL with reasons
```

Fail-open triggers, each a typed reason in the output:

| Reason | Fires when |
| --- | --- |
| `unmapped-file` | a changed file has no graph node (configs, lockfiles, assets) — declare irrelevant paths with `--ignore`. One exception: a **CMake hunk that does nothing but register new test targets** is read rather than refused, and the tests it declares are selected (see below) |
| `stale-graph` | the graph fails a content-root pin (`--expect-root`, or `--daemon-verify` against the live CGraph daemon), or `graph.json` is older than the head commit |
| `sparse-graph` | the graph averages under 3 edges per file — an under-extracted graph produces subsets that look smart and are blind, so blastline refuses |
| `disconnected-tests` | tests can forward-reach under 25% of the code's symbols — the graph passed the density floor but is blind for selection (how broken Go/Python extraction presented, and how every Rust graph presents today) |
| `diff-too-large` | the diff touches more files than `--max-files` (default 200) |
| `graph-unavailable` | no readable `graph.json` |
| `invalid-ignore-pattern` | an `--ignore` value is not a valid regex — note these are **regexes, not globs**, so `openspec/**` is an error and `^openspec/` is what you want |

Pure deletions map against a `--base-graph` when supplied, and degrade to the file node (a superset-safe approximation) when not.

**Test-registration files.** A build file has no graph node, so touching one normally fails the whole selection open — which made selection blind on exactly the PRs that *add* tests, since registering a test means editing the file that declares it. On our own dogfood loop, five of eleven CGraph PRs failed open and every one of them was a new test being registered. A CMake hunk that is **purely additive and does nothing but declare new test targets** is now read instead: at least one `add_test(NAME t …)`, an `add_executable(t src…)` for each, and no other command touching anything but those targets. The declared sources then seed the walk like any other changed test file.

Everything else still fails open, deliberately — a CMakeLists edit can change a compile flag or a link library in ways that affect every target in the file, and no line-level rule tells that apart from a registration. Any removed line, any command naming an undeclared target, any `${…}` expansion, the legacy positional `add_test` form, or a declared source that is missing from the graph all return to "run the full suite." Other build systems (Gradle, Cargo, Maven, Bazel) are not covered; they express this differently and a half-supported matrix is worse than none.

## Benchmarks

Replayed the last 20 first-parent commits of two repos, scoring every selection against the tests each commit's author co-changed ([methodology and full tables](openspec/changes/bootstrap-blastline/bench-results.md)):

| | production Next.js app | es-toolkit (1,508 files) |
| --- | --- | --- |
| subset rate | 19/20 | 18/20 |
| co-changed tests selected | 21/22¹ | **41/41** |
| mean selection | 25.7% of suite | 4.7% of ~670 tests |
| deterministic (double-run) | yes | yes |

¹ The one "miss" is a false positive of the co-change proxy itself — the author added new tests for unchanged code.

The benchmark also caught CGraph silently deleting 650 of es-toolkit's 1,508 files from the graph ([CGraph #39](https://github.com/Nxtsoft/CGraph/issues/39)/[#40](https://github.com/Nxtsoft/CGraph/issues/40), fixed in [#42](https://github.com/Nxtsoft/CGraph/pull/42)) — before the fix, blastline's sparse-graph guard correctly refused to produce subsets there. That loop is the design working: guard until the graph is trustworthy, select once it is.

### The safety audit

Replay benchmarks are a snapshot; the **safety audit** is the standing check. On every push to this repo's `main`, [safety-audit.yml](.github/workflows/safety-audit.yml) replays blastline's selection for the pushed range, runs the **full** suite, and records whether any failing test file fell *outside* the selection — an **escape**, the one outcome "safe superset" forbids. Each run appends a JSONL record to the [`safety-ledger`](https://github.com/Nxtsoft/blastline/tree/safety-ledger) branch and rolls the ledger into the badge above; a recorded escape turns it red and fails the run loudly. The evidence accumulates with every merge instead of resting on a one-time benchmark.

## Quick start

Prerequisites: Node 20+, a [CGraph](https://github.com/Nxtsoft/CGraph) binary on PATH, and a git repo.

```sh
npm install -g blastline        # or zero-install: npx blastline ...

cgraph --root ./src --out cgraph-out          # build the graph once
blastline tests main..HEAD | xargs vitest run
blastline blast main..HEAD                    # dependents with file:line
```

Working from source (contributors): `git clone https://github.com/Nxtsoft/blastline && cd blastline && bun install && bun run build`, then `node dist/cli.js …`.

## `blastline check` — the pre-edit verifier

Before you refactor, rename, or delete a symbol, ask what still references it:

```sh
blastline check callers 'src/io/mem.rs:poll_read_internal'
blastline check callers 'src/io/mem.rs:248' --exclude 'src/io/mem.rs:poll_read'   # "no OTHER callers?"
blastline check callers parse --transitive --json                                 # full blast radius, JSON
```

The subject is a `file:line`, a `file:label`, or a bare `label` (ambiguous labels
are reported, never guessed). `--exclude` drops the callers you are already
updating, so an empty result means "no *other* references."

**It refutes, it never certifies.** `verdict: refuted` — callers exist beyond your
exclusion set — is authoritative: those references are real, update them. `verdict:
no-static-callers` is **not** "safe to delete": dynamic dispatch, reflection, and
macro-generated calls are invisible to the graph, and every empty result says so.
The declaring file (a `contains` edge) is structural parentage, not a reference, and
is excluded from direct callers; `--transitive` gives the full `blast`-radius set.
Same fail-open honesty and content-root provenance as selection — a stale or
unreadable graph returns `UNVERIFIED` with a reason, never a false "all clear."

Agents call the same thing over MCP as `blastline_check` (`blastline mcp`).

## GitHub Action

Zero-config — point it at your source root and the Action installs CGraph and builds the graph itself:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: Nxtsoft/blastline@v0
  id: blastline
  with:
    graph-root: src                     # builds + caches the graph itself, no graph.json required
    github-token: ${{ github.token }}   # posts/updates the PR comment
```

Bring your own graph instead with `graph-path` — e.g. a monorepo build step, or when you also want `base-graph-command`'s deletion mapping. The two are mutually exclusive; the Action fails loudly if both are set:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: Nxtsoft/blastline@v0
  id: blastline
  with:
    graph-path: cgraph-out/graph.json
    base-graph-command: cgraph --root . --out "$BLASTLINE_BASE_OUT"
    github-token: ${{ github.token }}   # posts/updates the PR comment
    ignore: |
      \.md$
      ^docs/
```

Outputs: `kind` (`subset` or `all`) and `tests` (newline-separated files), so a downstream job can run only the selected tests. The comment shows the impacted tests and a collapsible blast radius; on fail-open it says "run the full suite" and why. With `graph-root`, the build is cached via `actions/cache` keyed on the tree hash of `graph-root` (`git rev-parse HEAD:<graph-root>`) rather than the graph's own content-root hash, since that hash lives inside `graph.json` and isn't known until after the build runs. `cgraph-version` (default `bin-v0.1.0`) pins the `Nxtsoft/CGraph` release tag the turnkey build installs from; currently Linux x64 runners only. With `graph-path`, supply your own graph from a cache keyed on your source tree, or let the run fail open honestly when no graph exists.

`base-graph-command` automates deletion mapping: the action checks out the
range's base commit into a worktree, runs your graph-build command there (it
must write `$BLASTLINE_BASE_OUT/graph.json`), and passes the result as the base
graph. A PR that deletes a file then selects the surviving tests that depended
on the deleted symbols, instead of failing open on an unmapped path — the
deleted code exists only in the base graph, so its dependents are walked there
and translated back to head paths. Skip the input and deletions keep the
documented safe degradation.

## Cross-repo selection over seam graphs

For microservice estates, point blastline at a [CGraph seam](https://github.com/Nxtsoft/CGraph) — the fused graph that joins per-service code graphs at their wire contracts:

```sh
cgraph seam gen  --seam seam.json --graphs backend=backend/graph.json --out drop
cgraph seam fuse --seam drop/chunk_00.json   --graph backend=backend/graph.json --graph ml-api=ml-api/graph.json --out fused

blastline tests main..HEAD --repo ./ml-api --graph fused/graph.json
```

A provider-side change then selects **consumer-side tests across the repo boundary**: a schema node is anchored to its canonical file, so editing it seeds the contract, and the walk crosses `RESPONDS_WITH` → the endpoint → `CONSUMED_AT`/`MIRRORED_BY` (dependency-flipped — the consumer depends on the contract, not vice versa) → the consumer's call sites and mirror types → their tests. Consumer-only changes never flow backwards into the provider. Verified end-to-end against a real `seam gen`/`seam fuse` pipeline: one provider schema edit selected exactly the consumer's test, with the contract chain in the blast radius.

## Use with coding agents

`blastline mcp` speaks MCP over stdio: newline-delimited JSON-RPC 2.0 implementing `initialize`, `tools/list`, and `tools/call` (protocol `2024-11-05`) — the same surface CGraph's own MCP server speaks.

```json
{
  "mcpServers": {
    "blastline": { "command": "blastline", "args": ["mcp"] }
  }
}
```

| Tool | What it answers |
| --- | --- |
| `blastline_tests` | "Which test files does this diff reach?" — the set to run before claiming done |
| `blastline_blast` | "What does this change touch, transitively?" — with `file:line`, before the edit is final |

Both take `repo` plus a `range` or raw `diff` text, with `graph_path`, `ignore`, and `min_density` passthroughs. A `kind: "all"` answer means run the full suite; the `reasons` say why — fail-open selections are returned as data, never as protocol errors, so an agent always gets an actionable answer.

## CLI reference

<details>
<summary><strong>⌨️ commands and options</strong></summary>

```sh
blastline tests <base>..<head> [options]     # impacted test files (list or --json)
blastline blast <base>..<head> [options]     # transitive dependents with file:line
blastline comment <base>..<head> [options]   # the PR-comment markdown
blastline mcp                                # MCP server over stdio
```

| Option | Meaning |
| --- | --- |
| `--repo <path>` | repository to diff (default: cwd) |
| `--graph <path>` | CGraph `graph.json` for head (default: `<repo>/cgraph-out/graph.json`) |
| `--base-graph <path>` | `graph.json` for base — improves pure-deletion mapping |
| `--diff-file <path>` | read a unified-0 diff from a file instead of running git |
| `--ignore <regex>` | repo-relative paths declared irrelevant (repeatable) |
| `--max-files <n>` | fail open above this many changed files (default 200) |
| `--min-density <n>` | fail open below this edges-per-file floor (default 3) |
| `--json` | structured output |

`tests`/`blast` print one item per line (empty = clean subset with nothing impacted); on fail-open they print `ALL` to stdout and one JSON reason per line to stderr, exit code 0 — consumers branch on the output, not the exit code.

</details>

## Status & roadmap

Scope, stated plainly: five of the seven language families are **replay-verified** — on their benchmarks every semantically selectable author-co-changed test was selected. TypeScript (Vitest/Jest): 43/43 on es-toolkit. Python (pytest conventions): 4/4 on itsdangerous, after CGraph#46 rebuilt Python import resolution. Go (`*_test.go`): 10/10 selectable on gorilla/mux, after CGraph#47 added interface-dispatch edges (`implements`/`dispatches_to` plus the member-call rescue for names like mux's eight `Match`es that satisfy one interface); the **dispatch barrier** (0.8.0) then cut Go's mean subset from 45.9% to 30.3% by stopping one implementation's change from cascading through the interface's structural neighborhood — the contract's *callers* stay selected, its sibling implementers don't. C/C++ (`*_test.{c,cc,cpp,cxx}` / `test_*`, the googletest/ctest convention): 62/62 on CGraph itself, after CGraph#52 made calls to overloaded functions edge to every member of the overload set; mean subset 22.4% of the suite, with every fail-open an honest build-system change (CMakeLists, submodule pointers). Java (Surefire/Failsafe conventions): 14/14 on stleary/JSON-java, after CGraph#68 and #69 — see below. Rust and Kotlin remain **advisory**.

**Rust (0.9.0) ships *advisory* — and stays there, because its one remaining genuine miss is the kind static analysis cannot close.** Detection follows Cargo's integration-test convention — `.rs` under a package-root `tests/`, excluding `mod.rs` shared helpers, `src/tests/` in-crate modules, and the `benches/`/`examples/` target kinds — and the runner recipe below is verified end-to-end (a real selection on sharkdp/fd `61c5399` folded to `cargo test --manifest-path …/Cargo.toml --test tests` and ran 108 tests, 0 failed; the clap workspace form ran the `builder` target, 912 tests, 0 failed). Rust was held to always-fail-open through 0.8.0 because test-file reachability into implementation symbols measured **0.000–0.142** across fd/clap/regex/ripgrep/serde/tokio, under the 0.25 `disconnected-tests` floor — the graph was too blind to select from. Three CGraph defects caused it (macro-interior calls never extracted, `impl` methods carrying no membership edge to their type, `use <crate_name>::…` producing no import edge), root-caused with a four-file reproduction in [CGraph#58](https://github.com/Nxtsoft/CGraph/issues/58) and fixed across #58/#59/#61, trait-scoped dispatch and `pub use` re-export following in [#62](https://github.com/Nxtsoft/CGraph/pull/62), and macro-interior item extraction in [#64](https://github.com/Nxtsoft/CGraph/pull/64). Reachability now measures **0.119 / 0.859 / 0.936 / 0.250 / 0.554 / 0.912** (fd / clap / regex / ripgrep / serde / tokio) — clearing the floor everywhere but the two thin graphs (fd, one test file; ripgrep, at the floor), so `blastline tests` returns real subsets and still fails open honestly on those two. tokio jumped from 0.591 to **0.912** at #64, once its `cfg_*!`-macro-wrapped code — 317 sites tree-sitter had left as opaque token-trees — became visible to the parser. Co-changed replay recall moved with it: clap **0/29 → 23/29**, tokio **1/12 → 11/12** (the jump to 11 came at #64). A dependency-filtered oracle (`scripts/bench-deps.ts` — revert the code, re-run the co-changed tests, keep only the ones that break) shows the residual proxy "misses" are mostly benchmark noise: on tokio, serde and regex, every behaviorally-checked miss was a cross-cutting cosmetic sweep (a clippy-lint rename, `{}`→`{name}` formatting, a `cfg(tokio_unstable)` cleanup) that co-changed test files without depending on the change — so serde's 0/2 is two non-dependents and regex's 4/9 is 4/4 of its real dependents. tokio's one behaviorally-confirmed genuine miss — `dd344a55`, hypothesized in [CGraph#60](https://github.com/Nxtsoft/CGraph/issues/60) as an async-dispatch gap but actually caused by `cfg_*!` macros hiding the calling method from the graph — **is closed at #64**: the reverse walk now reaches it (true recall 6/7 → 7/7). That leaves one behaviorally-confirmed genuine miss, on ripgrep (`2ed0c006`): reverting the flag change fails 14 tests in `tests/index/disallowed.rs`, so those tests genuinely depend on it — but they invoke the built `rg` binary as a subprocess (`process::Command::new(rg)`), not through any function call, so no static edge ties them to the flag code and none can. This is not a graph bug to fix; it is the boundary of static reachability — an integration test that shells out to the compiled artifact — and the precise reason `blastline tests` is a superset that fails open and **never certifies a selection as safe to skip**. It is also why Rust stays advisory rather than a hard gate: the fail-open net is doing exactly its job here. `--min-test-reachability 0` remains the opt-out to force selection on a graph under the floor. Rust unit tests are a separate matter, not a graph failure: they live inside the file they cover as `#[cfg(test)] mod tests`, so no path rule can name them and blastline does not pretend to — the file that declares them *is* the file under test, so "did my change reach them" is trivially yes whenever that file is in the diff. Selection therefore names integration targets only; pair the recipe with `cargo test --lib` when a library source file changed.

The pipeline is unit-tested (86 tests) and replay-benchmarked on nine repos (clap and tokio added in 0.9.0; stleary/JSON-java with the Java promotion); the Action and MCP server are exercised end-to-end in CI.

**JVM — Java is *replay-verified*; Kotlin (0.10.0) ships *advisory*.** `isTestPath` recognizes the JUnit conventions the build tools themselves collect — Maven Surefire's `Test*`/`*Test`/`*Tests`/`*TestCase`, Failsafe's `IT*`/`*IT`/`*ITCase`, and Kotest/Spek's `*Spec.kt` — over `.java` and `.kt` sources (`.kts` Gradle scripts excluded), and the runner recipe below folds a selected file to the fully-qualified class Gradle/Maven run. As with every language the ceiling is what CGraph extracts, and two CGraph fixes were needed to make JVM graphs selectable. Kotlin extraction was non-functional — zero symbols on real source, a grammar-field mismatch — until [CGraph#65](https://github.com/Nxtsoft/CGraph/pull/65) repaired it; a real Kotlin repo (cashapp/turbine) now measures test→implementation reachability **0.625**. Java constructor calls (`new Foo()`) produced no edge, severing the `test → class → methods` path that carries most of Java's reachability; [CGraph#66](https://github.com/Nxtsoft/CGraph/pull/66) resolves them, taking a constructor-heavy repo (stleary/JSON-java) from **0.241 → 0.847** and an interface/adapter-heavy one (google/gson) from **0.145 → 0.757** — both clearing the 0.25 disconnected-tests floor, so `blastline tests` returns real subsets instead of failing open. One gap remained after #66: interface/polymorphic dispatch, where a method name shared between an interface and its implementors is dropped as ambiguous — the gap CGraph#47 closed for Go with `implements`/`dispatches_to`, tracked as [CGraph#67](https://github.com/Nxtsoft/CGraph/issues/67) and **closed for Java in [CGraph#68](https://github.com/Nxtsoft/CGraph/pull/68)** (gson reachability 0.758 → **0.829**, `dispatches_to` 0 → 182, `implements` 0 → 155). [CGraph#69](https://github.com/Nxtsoft/CGraph/pull/69) then added a receiver tier — a member call whose receiver names its class scopes the lookup to that class — taking JSON-java from **0.853 → 0.929** and `XMLTest.java → XML.java` from 0 edges to 619, with 0 to `JSONML.java`.

**That is what promoted Java.** The 20-commit author-co-changed replay on stleary/JSON-java moved **8/14 → 14/14**: every semantically selectable co-changed test is now selected, including all five misses the dependency oracle (`scripts/bench-deps.ts`) had behaviorally confirmed as real by reverting the code and watching the tests break. Mean subset grew **0.435 → 0.499**, the honest cost of edges that were missing. Java now meets the same bar as the other verified families — one benchmark repo, every selectable co-changed test selected.

**Kotlin stays advisory, and the reason is narrow: no replay has been run.** Its graph is legible — cashapp/turbine reaches 0.625, well clear of the 0.25 floor — but reachability is not the bar. Until a Kotlin repo's author-co-changed replay is measured the way JSON-java's was, Kotlin selections inform rather than gate, and this README will not claim otherwise.

Runner recipes per ecosystem:

```sh
blastline tests main..HEAD | xargs vitest run                                  # TS/JS
blastline tests main..HEAD | xargs pytest                                      # Python
blastline tests main..HEAD | xargs -n1 dirname | sort -u | xargs go test       # Go (tests run per package)
blastline tests main..HEAD | xargs -n1 basename | sed -E 's/\.(c|cc|cpp|cxx)$//' \
  | xargs -I{} ctest --test-dir build -R {}                                    # C/C++ (ctest name match)
blastline tests main..HEAD | sed -E 's#^(.*)/tests/([^/]+).*#\1 \2#; s#\.rs$##' | sort -u \
  | while read -r pkg t; do cargo test --manifest-path "$pkg/Cargo.toml" --test "$t"; done   # Rust
blastline tests main..HEAD \
  | sed -E 's#^.*/src/test/(java|kotlin)/##; s#\.(java|kt)$##; s#/#.#g; s/^/--tests /' \
  | xargs ./gradlew test                                                        # JVM (Gradle, JUnit)
```

The JVM recipe maps a selected file back to the fully-qualified class name Gradle/Maven select by — Gradle's `--tests` and Maven's `-Dtest` take a class, not a path. Under the standard layout the package path is everything after `src/test/{java,kotlin}/`, so stripping that prefix, dropping the extension, and turning `/` into `.` yields `com.example.CalculatorTest` from `.../src/test/kotlin/com/example/CalculatorTest.kt`. Maven is the same transform with a comma-joined list: `… | paste -sd, - | xargs -I{} mvn -Dtest={} test`. A helper or abstract base under `src/test/` that a change touches still selects the concrete tests that use it through the dependents walk, so it need not match the runnable-test name convention itself.

The Rust recipe folds a selected file back to the Cargo target that owns it: `tests/<name>.rs` and every file under `tests/<name>/` belong to target `<name>`, and the directory above `tests/` is the package, so `--manifest-path` keeps workspaces (clap, tokio, ripgrep) pointed at the right member. Selection is finer-grained than Cargo can run — several selected files can collapse to one target — so `sort -u` is load-bearing, not decoration.

Freshness pinning shipped in 0.3.0: CGraph one-shot builds embed a sha256-merkle-v1 content root, every subset carries it as provenance (CLI JSON, MCP payloads, and the PR-comment footer), `--expect-root` pins a selection to an exact tree, and `--daemon-verify` pins against the live CGraph daemon's root — verified end-to-end against a running graphd (match → subset; edited tree → fail-open naming both roots). Cross-repo selection over seam graphs shipped in 0.4.0 (see above) — the proposal roadmap is complete.

## Contributing

Issues and PRs welcome. The spec-driven history lives in [`openspec/`](openspec/changes/bootstrap-blastline/) — proposal, spike findings, and benchmark results — and is the fastest way to understand why the tool is shaped the way it is. `bun run build && bun run test` is the gate.

## License

[MIT](LICENSE).
