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
