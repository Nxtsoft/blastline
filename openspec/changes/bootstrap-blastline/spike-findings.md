# Phase-1 spike findings (2026-08-18)

Ran `scripts/spike.ts` against real CGraph graphs (fresh `graph.json` exports) on two repos:
OpenNxtsoft at origin/main `fd88922` (320 nodes / 718 edges from 69 files) with three real
historical commits, and blastline itself (10 nodes / 17 edges) with a synthetic edit.

## Validated

1. **Diff→node mapping works on real diffs.** Commit `109fd18` (jsonld SEO fix): all six
   symbol-level ranges resolved to the two functions that commit actually edited
   (`generateTechArticleJsonLd [206-246]`, `generateSoftwareApplicationJsonLd [271-291]`),
   confirmed against source lines. Module-scope regions not covered by a symbol span fell
   back to the file node as designed.
2. **Smallest-containing-span selection fires.** Nested candidates were correctly reduced
   ("won over 11 wider" on `figures.tsx`).
3. **Non-code files fail open.** `.mdx`/`.md` changes reported UNMAPPED — exactly the
   fail-open trigger the proposal specifies.
4. **The test-intersection loop closes.** On blastline's own graph, a one-line synthetic
   edit inside `parseUnifiedDiff [13-72]` seeded the function node; the transitive-dependent
   walk reached `diff.test.ts` via its `imports` edge to the function, and the test detector
   flagged it: impacted tests = exactly the right one.

## Defect found (this is why the spike exists)

**Single-smallest-per-range is wrong for large ranges.** For a whole-file addition
(`figures.tsx:1-143`), picking the single smallest node whose span intersects the range
selected `type FigureProps [9-12]` — one tiny symbol out of a file where *every* symbol is
new. Same on `freshness-figures.tsx:1-105` → `variable [103-105]`.

**Corrected rule for phase 2:** seeds = the union over changed *lines* of the smallest
containing non-file node — equivalently, every innermost node whose span intersects the
range — not one winner per range. Added files degenerate to "all symbols in the file," which
is the correct semantics.

## Observations for phase 2

- CGraph TS graphs carry the relations needed: `contains`, `imports`, `imports_from`,
  `CALLS`, `inherits`, `re_exports`. The dependent walk should traverse incoming edges of all
  of them (`re_exports` matters: `index.ts` re-exports make barrel consumers dependents).
- Node `source_file` is absolute; diff paths are repo-relative. Suffix matching works but
  phase 2 should normalize against the extraction root explicitly.
- File nodes have degenerate spans (`1-1`), so the non-file filter is load-bearing.
- Deletions map against the head graph in the spike; phase 2 needs the base graph for
  deleted spans, as the proposal already states.
