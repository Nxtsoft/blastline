# Proposal: `blastline check` — agent claim verifier

Promotes the v2 non-goal recorded in `bootstrap-blastline/proposal.md:66`
("the agent claim verifier (`blastline check "no-other-callers X"`) — designed-for
but v2; it reuses the same query layer") into a scoped change. The query layer it
reuses now exists and is stable: `dependents()` (the reverse-reachability walk),
`graph.incoming` (target → callers adjacency, `src/graph.ts:31`), `nodesForPath`
(symbol resolution, `src/graph.ts:96`), freshness pinning, and the fail-open
`Selection` machinery.

## Why

1. **The agent use case is the one blastline hasn't served yet.** `tests` and
   `blast` are *diff-driven* — they answer "given this change, what's impacted."
   An agent mid-refactor has a different, earlier question: *"before I change/rename/
   delete symbol X, does anything else depend on it that I haven't accounted for?"*
   That is symbol-driven, and today the agent has to open a PR and read the `blast`
   output to get it. `check` is the pre-edit query.

2. **It is the cheapest new surface with the highest new reach.** It reuses the
   entire existing pipeline — the reverse walk, symbol indexing, freshness proofs,
   fail-open reasons — and adds one resolution step and one command. No CGraph
   engine change (same zero-fork contract as v1). The primary consumer is an agent
   over MCP, so it extends blastline from a CI test-selector into an interactive
   agent tool without a second engine or a second graph.

3. **It composes with the freshness differentiator.** A verification answer that
   ships with `content_root` provenance is one an agent can trust came from the
   tree it is actually editing — the same proof no incumbent offers, applied to a
   new question.

## What it is

A symbol-driven claim check over the head graph. One core operation, two surfaces
(CLI + MCP), reusing the diff-driven pipeline's internals.

**Pipeline:** resolve `<symbol>` → graph node → walk `graph.incoming`
(depth-1 default; transitive via the existing `dependents()`), minus an
agent-supplied `--exclude` set → verdict + caller list + provenance.

**Surfaces:**
1. **CLI** — `blastline check callers <symbol> [--exclude <symbol>…] [--depth N]`
   prints the static callers (list/JSON) and a verdict.
2. **MCP server** — a `blastline_check` tool alongside `blastline_tests` /
   `blastline_blast`, so a coding agent pre-flights an edit against the exact tree
   it is editing.

## Verification semantics: a falsifier, never a certifier

This is the load-bearing design decision, and it is the same superset-honesty the
rest of the tool ships. CGraph edges are a superset with approximate coverage
(dynamic dispatch, reflection, macros are invisible), so `check` can refute a
claim but must never certify one:

- **Callers found beyond the excluded set → authoritative refutation.** "These *do*
  reference X" is high-confidence; this is the valuable direction — it catches the
  caller the agent was about to break. Verdict `refuted`.
- **No callers found → weak signal, never "safe to delete."** The graph cannot see
  dynamic references, so an empty result is `no-static-callers`, explicitly *not* a
  removal certificate. Verdict carries the same fail-open caveat as an `ALL`
  selection.
- **Determinism.** Same tree + same symbol + same exclude set → byte-identical
  result, like every other blastline output.

`check` must never emit "safe to remove X." It emits the set of static references
it can see and says what it cannot. Any wording that reads as a completeness
guarantee is a bug, not a feature.

## Contract with CGraph (consumes, never forks)

**Zero engine changes**, same as v1. `check` reads the same `graph.json` /
daemon surfaces `tests`/`blast` already use, and lands in the op-stats ledger like
any other client query. No new export, no new daemon op.

## New work blastline owns

1. **Symbol resolution.** Turn an agent-supplied reference into a graph node.
   MVP accepts `file:line` (most robust — it is what an agent has from a diff hunk)
   and `file:label`; a bare label lists all matches rather than guessing. Extends
   `nodesForPath` (`src/graph.ts:96`) with a line-span and label match.
2. **The `callers` query.** Depth-1 direct callers from `graph.incoming`; `--depth`
   (or `--transitive`) reuses `dependents()` unchanged. The `--exclude` diff yields
   the "no *other* callers" framing.
3. **Verdict framing + output shape.** A `CheckResult` mirroring `Selection`
   (callers, verdict, excluded, reasons, `contentRoot`), with the fail-open reasons
   `symbol-not-found` (new), `stale-graph`, `graph-unavailable` reused.
4. **The `blastline_check` MCP tool.** Schema + handler alongside the existing two,
   sharing repo/graph/freshness inputs.

## Scope (deliberately small)

- **One claim: `callers` / `no-other-callers`.** The one named in the original
  proposal and the one agents ask most.
- **One resolution mode that always works: `file:line`** (plus `file:label`).
- **Both query paths** — one-shot `graph.json` and daemon — inherited for free.
- **All five detected languages** — resolution and the reverse walk are
  language-agnostic; nothing here is TS-specific (Rust now ships advisory as of the
  CGraph#62 graph, so a Rust `check` is meaningful where the graph clears the floor).

### Non-goals (each a recorded follow-up)
- Other claims: `no-callers` (dead-code sweep), `reachable-from A B`, `only-callers
  <set>`, `unused-export`. Same query layer; add once `callers` proves the surface.
- Any "safe-to-delete" / completeness certification — permanently out; it violates
  the superset contract.
- Cross-repo checks over seam graphs (composes on `cgraph seam`, later).
- Batch/whole-repo verification passes (v1 is one symbol per call).

## Design sketch

```
blastline check callers <symbol> [--exclude S…] [--depth N] [--graph …] [--json]
  1. load graph:  daemon (local) | cgraph-out/graph.json (CI/agent)   (reused)
  2. verify freshness: expected_content_root == HEAD tree hash        (reused)
  3. resolve <symbol> -> node:
       file:line  -> smallest node whose span contains the line
       file:label -> node with matching label in that file
       bare label -> all matches (report ambiguity, do not guess)
       none       -> fail open: reason symbol-not-found
  4. callers = graph.incoming[node]           (depth-1)
             | dependents(graph,[node])        (--transitive / --depth>1)
  5. callers -= resolve(--exclude)             (the "no other callers" framing)
  6. verdict = callers.nonEmpty ? "refuted" : "no-static-callers"
  7. emit: { claim, symbol, callers[file:line,relation,kind], verdict,
             excluded, reasons, contentRoot }   (list | JSON | MCP payload)
  fail-open at steps 1-3; reason always present
```

Implementation language: **TypeScript**, in the existing package — `check` is a new
command module + one MCP tool over primitives that already exist.

## Prior art

`sdsrss/code-graph-mcp`'s blast-radius MCP framing is the nearest conceptual
neighbor (already noted in the v1 proposal); differentiate the same way — directed
edges, freshness provenance, and refuter-not-certifier honesty rather than an
unqualified "impact" number. No incumbent ships a symbol-level pre-edit check with a
content-root proof.

## Risks

- **Certifier misread.** The single largest risk: an agent treats
  `no-static-callers` as "safe to delete." Mitigated by verdict naming, an explicit
  caveat string in every empty result, and MCP tool-description wording that leads
  with "refutes, does not certify."
- **False-positive edges → phantom callers.** Over-approximation can name a caller
  that is not real. This is the *safe* failure for this tool (it errs toward "don't
  delete"), and it is exactly what the refuter framing wants; documented, not fixed.
- **Symbol ambiguity.** Bare labels collide; MVP refuses to guess and reports all
  matches, pushing the agent toward `file:line`.

## Success criteria (done when)

1. On a real repo, `blastline check callers file:line` on a symbol with known
   callers lists exactly the graph's incoming references, and `--exclude` of those
   yields `no-static-callers`.
2. On a symbol an untracked (dynamic) path also calls, the result still lists the
   static callers and the output never states or implies removal safety.
3. An agent (Claude Code) calls `blastline_check` over MCP mid-edit and acts on the
   caller list before opening a PR, end-to-end.
4. `symbol-not-found`, `stale-graph`, and `graph-unavailable` each fail open with a
   stated reason; result is byte-identical across two runs on the same commit.

## Task phases

1. **Symbol resolution** — `file:line` / `file:label` / bare-label-ambiguity over
   `nodesForPath`, with a fixture asserting smallest-containing-span selection.
2. **`check` command** — `callers` query on `graph.incoming` + `--depth`/
   `--transitive` via `dependents()`, `--exclude`, `CheckResult` shape, fail-open
   reasons, list/JSON output. Fixture: symbol with known callers → list, refutation,
   exclusion→empty, not-found→fail-open.
3. **`blastline_check` MCP tool** — schema + handler; agent workflow doc line.
4. **README** — a `check` section under the CLI usage, leading with the
   refuter-not-certifier contract.
