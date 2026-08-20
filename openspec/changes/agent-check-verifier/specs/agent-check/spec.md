# agent-check

The symbol-driven claim verifier: given a symbol and a claim about it, blastline
answers from the CGraph head graph with the same fail-open, superset-honest
contract as test selection. It refutes claims; it never certifies them.

## ADDED Requirements

### Requirement: Symbol resolution

The verifier SHALL resolve an agent-supplied symbol reference to a single graph
node before querying, accepting `file:line` and `file:label` forms, and SHALL NOT
guess when a reference is ambiguous.

#### Scenario: Resolve by file and line

- **WHEN** `check callers <file>:<line>` is run and exactly one node's source span
  contains that line
- **THEN** the smallest such containing node is selected as the subject symbol

#### Scenario: Resolve by file and label

- **WHEN** `check callers <file>:<label>` is run and one node in that file has the
  given label
- **THEN** that node is selected as the subject symbol

#### Scenario: Ambiguous bare label is not guessed

- **WHEN** a bare label resolves to more than one node
- **THEN** the verifier reports all matching nodes and does not pick one

#### Scenario: Unresolvable symbol fails open

- **WHEN** the reference resolves to no node in the graph
- **THEN** the result carries the fail-open reason `symbol-not-found` and no verdict
  of safety is implied

### Requirement: Callers query

The verifier SHALL report the static callers of the subject symbol from the graph's
incoming edges, support transitive expansion, and subtract an agent-supplied
exclusion set to express the "no other callers" question.

#### Scenario: Direct callers

- **WHEN** `check callers <symbol>` is run at the default depth
- **THEN** the result lists every node with an incoming edge into the subject
  symbol, each with its file, line, relation, and kind

#### Scenario: Transitive callers

- **WHEN** `--depth` greater than one (or `--transitive`) is supplied
- **THEN** the result lists the transitive dependents of the subject symbol,
  computed by the same reverse walk that powers `blast`

#### Scenario: Exclusion set

- **WHEN** `--exclude <symbol>...` names callers the agent is already updating
- **THEN** those callers are removed from the reported set and listed separately as
  excluded

### Requirement: Falsifier semantics

The verifier SHALL treat found callers as an authoritative refutation and an empty
caller set as a weak signal, and SHALL NEVER emit a claim that a symbol is safe to
remove.

#### Scenario: Callers remain after exclusion

- **WHEN** callers exist beyond the exclusion set
- **THEN** the verdict is `refuted` and the surviving callers are reported

#### Scenario: No static callers found

- **WHEN** no callers remain after exclusion
- **THEN** the verdict is `no-static-callers`, accompanied by an explicit caveat
  that dynamic dispatch, reflection, and macros are invisible to the graph

#### Scenario: No certification wording

- **WHEN** any result is emitted
- **THEN** it contains no statement that the symbol is safe to delete or that the
  caller set is complete

### Requirement: Fail-open, freshness, and determinism

The verifier SHALL reuse the selection pipeline's fail-open reasons, content-root
provenance, and determinism guarantees.

#### Scenario: Stale or unavailable graph fails open

- **WHEN** the graph is unavailable, or its content root does not match the checked
  out tree under `--expect-root` / `--daemon-verify`
- **THEN** the result carries `graph-unavailable` or `stale-graph` and no caller
  claim is trusted

#### Scenario: Provenance on every result

- **WHEN** a result is emitted
- **THEN** it carries the graph's `content_root` as provenance, identical in shape
  to a test selection

#### Scenario: Deterministic output

- **WHEN** `check` is run twice on the same tree, symbol, and exclusion set
- **THEN** the two results are byte-identical

### Requirement: Agent surface

The verifier SHALL be callable both from the CLI and as an MCP tool for agents.

#### Scenario: CLI command

- **WHEN** `blastline check callers <symbol> [--json]` is invoked
- **THEN** it prints the caller list (or JSON result) and exits 0, with fail-open
  results returned as data rather than as an error

#### Scenario: MCP tool

- **WHEN** an agent calls the `blastline_check` MCP tool with a repo, symbol, and
  optional exclusion set
- **THEN** it receives the same `CheckResult` payload, and the tool description
  leads with the refuter-not-certifier contract
