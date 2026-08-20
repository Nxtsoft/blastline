# Tasks: agent-check-verifier

## 1. Symbol resolution
- [ ] 1.1 Extend `nodesForPath` (`src/graph.ts`) with `file:line` (smallest
  containing span) and `file:label` resolution
- [ ] 1.2 Bare-label ambiguity: return all matches, never guess
- [ ] 1.3 Unresolvable reference → `symbol-not-found` fail-open reason (new
  `FailOpenReason` variant in `src/types.ts`)
- [ ] 1.4 Fixture: assert smallest-containing-span selection and ambiguity handling

## 2. `check` command
- [ ] 2.1 New command module `check callers <symbol>` in `src/cli.ts`
- [ ] 2.2 Direct callers from `graph.incoming`; `--depth`/`--transitive` via
  existing `dependents()`
- [ ] 2.3 `--exclude <symbol>...` subtraction → "no other callers" framing
- [ ] 2.4 `CheckResult` type mirroring `Selection` (callers, verdict, excluded,
  reasons, contentRoot); verdict `refuted` | `no-static-callers`
- [ ] 2.5 List + `--json` output; fail-open returned as data, exit 0
- [ ] 2.6 Fixture: symbol with known callers → list; exclude-all → `no-static-callers`;
  not-found → fail-open; determinism (two runs byte-identical)

## 3. MCP tool
- [ ] 3.1 `blastline_check` schema + handler in `src/mcp.ts`, sharing repo/graph/
  freshness inputs with the existing tools
- [ ] 3.2 Tool description leads with "refutes, does not certify"

## 4. Docs
- [ ] 4.1 README `check` section under CLI usage, leading with the falsifier contract
- [ ] 4.2 Agent workflow line: pre-edit `blastline_check` over MCP

## 5. Verify
- [ ] 5.1 `bun run build` clean, unit suite green
- [ ] 5.2 End-to-end: an agent (Claude Code) calls `blastline_check` over MCP mid-edit
  and acts on the caller list
