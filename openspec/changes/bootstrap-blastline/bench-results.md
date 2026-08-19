# Phase-3 benchmark results (2026-08-18)

Historical-commit replay via `scripts/bench.ts`: for each of the last 20 first-parent commits
touching `src/`, build the commit's CGraph graph in a worktree, run selection on the commit's
real diff, and score it. Safety proxy: every test file the author co-changed in the same
commit must appear in the selection computed from the non-test changes alone. CGraph binary:
fresh `build/default` (post-Rust-merge, 2026-08-18).

## Repos

- **webapp** (`~/nxtsoft/webapp`) — NxtSoft production Next.js/TS app, 164 commits, 11 test files.
- **es-toolkit** (github.com/toss/es-toolkit @ `3aa823c9`) — large public TS library, 1,508
  source files, ~688 colocated spec files, dual `src/` + `src/compat/` package shape.

Two configurations each: bare (no ignore rules, no base graph) and configured (realistic
`--ignore` set + `--with-base-graph`).

## Headline numbers

| | webapp bare | webapp configured | es-toolkit bare | es-toolkit configured |
|---|---|---|---|---|
| subset rate (vs fail-open ALL) | 12/20 | **19/20** | 6/20 | 6/20 |
| mean selection (share of suite) | 15.7% | 25.7% | 0.22% | 0.22% |
| co-changed-test proxy | 21/22 | 21/22 | 36/43 | 36/43 |
| proxy on subset rows only | — | 21/22¹ | — | **1/8** |
| deterministic (double-run) | yes | yes | yes | yes |
| mean graph build | 293ms | 319ms | 11.5s | 11.5s |
| mean selection time | <1ms | <1ms | ~1ms | ~1ms |

¹ webapp's single proxy miss is a false positive of the proxy itself, not a selection error
(see below).

## What the numbers mean

**On a well-shaped repo (webapp), selection works.** With a realistic ignore config and base
graphs, 19/20 historical commits got a subset instead of a full run, the mean subset was a
quarter of the suite, and every genuinely-related co-changed test was selected. The one
remaining ALL was a commit touching root-level `api/` files outside the extraction root —
the correct honest outcome.

**webapp's one proxy "miss" is a proxy limitation, not an escape.** Commit `a0cf56f9`
changed only `page.tsx` files and *added new tests* to `lib/blog.test.ts`; the test imports
`lib/blog.ts` (unchanged), not the pages. The author co-changed the test as new coverage for
adjacent behavior. Graph-wise the test is not a dependent of the changed code, and selecting
it would have been a lucky guess, not an inference. Co-change is a proxy, and this is its
known failure mode; we report it rather than tune it away.

**On es-toolkit, selection is currently unsafe — and that is an extraction finding, not a
pipeline finding.** Only 1 of 8 co-changed tests on subset commits was selected. Root cause,
verified by direct graph inspection at commit `1a629d17`:

- The graph is pathologically sparse: 1,508 files produced 2,268 nodes and **1,667 edges**
  (~1.1 edges/file; blastline's own graph has ~8.7, webapp's is similar). Most files have no
  `contains`/`imports` edges at all.
- Concrete mis-resolution: `src/compat/function/debounce.spec.ts` imports `./debounce`
  (same directory) plus three `../../` modules — its only outgoing edge in the graph is a
  single `imports_from → src/function/index.ts`. The same-dir import is gone and the one
  surviving edge points at the wrong package half (basename collision between
  `src/function/debounce.ts` and `src/compat/function/debounce.ts`).
- Several `src/**/*.ts` files (`fp/iterator/*.ts`, `object/index.ts`, `util/index.ts`)
  produce **no node whatsoever** in either the head or base graph — extraction skips them
  outright.

With so few incoming edges, the dependents walk terminates almost immediately, selecting 1-3
tests of ~670. The subsets are tiny because the graph is blind, not because the tool is smart.

## Consequences for the tool (phase-4 requirements)

1. **A graph-density fail-open guard.** blastline must refuse to produce a subset from a
   graph it can demonstrate is under-extracted — a conservative edges-per-source-file floor
   (webapp ≈ 10, blastline ≈ 8.7, es-toolkit ≈ 1.1 — the gap is an order of magnitude, so a
   floor near 3 separates them cleanly) emitting a new `sparse-graph` fail-open reason. This
   errs toward full runs, the safe direction, and turns the es-toolkit failure mode into an
   honest ALL.
2. **Upstream CGraph issues to file** (reproducers in this document):
   a. TS relative-import resolution drops same-dir imports and mis-resolves across basename
      collisions (`compat/` shape).
   b. Some TS files yield no node at all (`src/fp/iterator/*.ts` at es-toolkit `f36f9653~1`).
3. **Base graphs are worth the cost on small repos** (webapp subset rate 12/20 → 19/20
   combined with the ignore config, ~300ms per graph) and irrelevant until extraction is
   fixed on large ones.

## Honest scope notes

- The co-change proxy under-approximates escaped failures (a missed test that the author
  didn't co-change is invisible to it) and over-approximates them (webapp's `a0cf56f9`).
  Mutation-based ground truth is the stronger follow-up once selection is gated on density.
- All runs were double-executed; selection was byte-identical every time.
- `ALL` rows count the proxy as trivially satisfied (a full run cannot miss a test); the
  subset-rows-only line is the number that matters for safety.

## Addendum (2026-08-19): after the CGraph fix

CGraph issues #39/#40 were root-caused to one bug (import stubs squatting real node ids on
extension-spelled specifiers) and fixed in taylor009/CGraph#42. Re-running the identical
20-commit es-toolkit replay with the fixed binary:

| es-toolkit (configured) | before fix | after fix |
|---|---|---|
| graph | 858 file nodes, 1,667 edges (1.1/file) | 1,508/1,508 file nodes, 9,793 edges (6.49/file) |
| subset rate | 6/20 | **18/20** |
| proxy on subset rows | **1/8** (unsafe) | **41/41** (zero missed) |
| mean selection | 0.22% (blind-graph artifact) | 4.7% of ~670 tests |
| deterministic | yes | yes |

The two remaining ALLs are honest fail-opens on commits touching files outside the graph.
The sparse-graph guard no longer fires (density 6.49 > floor 3) — exactly the designed
behavior: guard until the graph is trustworthy, select once it is.

## Addendum 2 (2026-08-19): Python and Go

Detectors added for pytest defaults (`test_*.py`, `*_test.py`) and Go (`*_test.go`); the
pipeline is language-agnostic beyond that. Fixture-level end-to-end works for both (a
symbol edit selects the co-located test via a resolved cross-file CALLS edge). Replaying
20 commits per real repo told a different story:

| | gorilla/mux (Go) | pallets/itsdangerous (Python) |
|---|---|---|
| subset rate (pre-guard) | 20/20 | 17/20 |
| proxy on subset rows (pre-guard) | ~2/11 real | 0 selected on every subset |
| root cause | receiver-method calls (`r.Match()`) resolve to **zero** cross-file edges — route.go's 53 symbols have no incoming CALLS from any other file | **no import edges at all**, and class instantiations (`Signer(...)`) / method calls don't resolve — tests/ are disconnected from src/ |
| edges/file density | 32.6 (passes the sparse guard) | 13.5 (passes the sparse guard) |

Both graphs pass the density floor while being blind for selection — a guard blind spot.
The fix is a second structural guard, **test reachability**: the fraction of non-test
symbols forward-reachable from the repo's tests. Measured across all benched graphs it
separates cleanly:

| graph | coverage |
|---|---|
| es-toolkit (fixed) | 1.00 |
| blastline | 0.62 |
| webapp | 0.52 |
| **gorilla/mux** | **0.11** |
| **itsdangerous** | **0.07** |

`disconnected-tests` now fails open below a 0.25 floor (`--min-test-reachability`). With
the guard, both repos replay as honest ALLs instead of false subsets.

Also fixed in the harness: test-only commits (the author added a test, changed no code)
are no longer scored against the proxy — an empty selection from an empty code diff is
correct, not a miss (2 of mux's 11 apparent misses were this artifact).

**Status:** Python and Go are detector-complete and pipeline-verified, gated on upstream
CGraph extraction quality — Go receiver-method call resolution and Python import /
instantiation resolution, filed upstream with reproducers. When those land, the guard
stops firing by itself, exactly as happened with es-toolkit and #42.

## Addendum 3 (2026-08-19): Python and Go after CGraph#46

taylor009/CGraph#46 (fixes #44/#45) added method-aware member-call resolution and a real
Python import pipeline. Test reachability on the reproducer repos: gorilla/mux 0.11 → 0.50,
pallets/itsdangerous 0.07 → 1.00 — both clear the disconnected-tests floor, so selection
un-gates. Re-running the 20-commit replays with the fixed binary (and two harness
corrections: commits filtered to source changes via --graph-root, and co-changed tests that
the commit itself deleted are unscoreable):

| | gorilla/mux (Go) | pallets/itsdangerous (Python) |
|---|---|---|
| subset rate | 20/20 | 18/20 |
| proxy on subset rows | 7/11 | **3/3 (zero missed)** |
| mean selection | 8.9% of suite | 2-5 of 5 tests on code commits |
| deterministic | yes | yes |

**Python selection is now safe on this benchmark** — every surviving author-co-changed test
was selected.

**Go is improved but not yet safe to gate on**: 4 of 11 co-changed tests were still missed.
Each miss traces to interface dispatch — the test exercises the changed method through an
interface value (http.Handler-style), a binding no static name-based resolver can see. Use
Go selection as an advisory signal (what to run first), not a skip-gate, until CGraph grows
interface-implementation edges.

## Addendum 4 (2026-08-19): Go replay-safe after interface dispatch (CGraph#47)

CGraph#47 added interface-dispatch resolution: Go receiver attribution (`method_of`),
interface method-set extraction, `implements`/`dispatches_to` edges, and a member-call
rescue — an ambiguous member call binds to the single interface method promising that name,
so dependents flow contract → implementations (mux declares `Match` on eight types because
they satisfy one `matcher` interface; that pattern is why 4 misses survived #46).

| gorilla/mux (Go) | after #46 | after #47 |
|---|---|---|
| test reachability | 0.50 | **0.65** |
| proxy on subset rows | 7/11 | **10/11** |
| the one remaining "miss" | — | an empty `TODO` test body that calls nothing — semantically unselectable, so **10/10 selectable tests selected** |
| mean selection | 8.9% | 37.7% (dispatch fan-out trades selectivity for safety; still a 2.7× reduction) |
| deterministic | yes | yes |

All three v1 languages are now replay-verified on their benchmarks: TS 41/41, Python 3/3,
Go 10/10 selectable.

## Addendum 5 (2026-08-19): cross-repo selection over seam graphs (0.4.0)

blastline now consumes CGraph fused seam graphs. Two mechanics: (1) `CONSUMED_AT` and
`MIRRORED_BY` are dependency-flipped when building the traversal index (the consumer depends
on the contract, not vice versa), applied to both the dependents walk and the reachability
guard; (2) path→node mapping unions all suffix matches and seeds location-less file-anchored
nodes (a schema node anchored to its canonical file) unconditionally — extra seeds only widen
the superset.

Verified against a real `seam gen`/`seam fuse` pipeline (two TS services, one contract): a
one-line provider schema edit selected exactly the consumer repo's test, blast radius showing
endpoint → consumer call site → mirror type → consumer service; a consumer-only edit selected
the same test WITHOUT flowing backwards into the provider. Known scope limit, stated: the
seam anchors consumer call sites and mirrors, not provider handler functions — a provider
change reaches consumers via its schema/endpoint files, which is what the seam spec encodes
today.
