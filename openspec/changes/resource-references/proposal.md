# Proposal: say which code reads an unmapped file (advice, not selection)

## Why

Every "run the full suite" verdict in the last 60 PRs of six repositories
running Blastline came from `unmapped-file`: a changed config, data or build
file the graph has no node for. Many of those files are read by code that says
so -- a test that opens `fixtures/rows.csv`, a migration test walking
`migrations/`, a Spring test loading `application-production.yml` -- so the
short list of tests that most likely covers the change is knowable. Reviewers
want it even when the run cannot shrink.

## Why advice, not selection

The first version of this change let those readers replace the full suite. An
independent review built probes where it silently dropped real tests: a pytest
fixture in `conftest.py` (no graph edge to the tests that use it), subclasses of
a `@SpringBootTest` base class and classes carrying a meta-annotation, paths
built from a stem (`loadFixture("rows")`), Go `os.ReadDir`, Rust `#[files]`,
profiles activated through a constant. Every rule added to close those holes
made the resolver stricter; the version strict enough to be safe vouched for
none of 30 real full-suite PRs, because build files, CI workflows and
`package.json` mention folder names that grep cannot tell from real readers.
Selection is a safe superset, so it stays the full suite; the readers become
advice.

## What Changes

- **`src/references.ts` (new).** `resolveReferences` returns, per unmapped
  file, its readers (name, path-part, spring-profile, spring-context rules) and
  caveats (what it could not vouch for). A non-code reader is followed to the
  code that names it; lockfiles and repository metadata are never readers.
- **`src/mapping.ts`.** `seedLines` is shared by changed lines and readers;
  `readerNodes` seeds each reader at the innermost symbol around its lines.
- **`src/select.ts`.** When selection fails open, each `unmapped-file` reason
  gains `readers`, `readerTests` and `caveats`. The verdict is unchanged.
- **`src/comment.ts`.** A reader table under the unmapped block.
- **`src/unnamed.ts`.** The convention list is shared (`loadedByConvention`,
  `isLockfile`) and gains `.mvn/`, `.envrc`, `junit-platform.properties`,
  `mockito-extensions/`.

## Measured

Replayed over the 30 recorded full-suite PRs, each at its head with the
repository's own `ignore` list and `graph-root`, against a fresh cgraph graph:
verdicts identical to 0.16.0 on all 30; 17 of the 29 full-suite PRs get a
reader table. On the motivating Spring PR the table names 4 readers reaching 6
tests (the two tests that load the file, plus infrastructure code that sets
the profile), computed in under a second.
