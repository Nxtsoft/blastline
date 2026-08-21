import type { CodeGraph } from "./graph.js";
import { dependencyDirection } from "./graph.js";

/**
 * Test-file conventions per ecosystem:
 * - JS/TS (Vitest/Jest): *.test.* / *.spec.* files and __tests__ directories
 * - Python (pytest collection defaults): test_*.py and *_test.py — a tests/
 *   directory alone is NOT a signal (helpers and fixtures live there too),
 *   and conftest.py is fixture plumbing, not a test
 * - Go: *_test.go, the compiler-enforced convention
 * - C/C++ (googletest/ctest convention): *_test.<ext> and test_*.<ext> for
 *   translation units only (.c/.cc/.cpp/.cxx) — headers are shared fixtures,
 *   and fuzz harnesses (*_fuzzer.cpp) deliberately do not match
 * - Rust (Cargo integration tests): see isRustTestPath
 * - JVM / JUnit (Java + Kotlin): see isJvmTestPath
 */
export function isTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)__tests__\//.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.py$/.test(path) ||
    /_test\.go$/.test(path) ||
    /_test\.(c|cc|cpp|cxx)$/.test(path) ||
    /(^|\/)test_[^/]*\.(c|cc|cpp|cxx)$/.test(path) ||
    isRustTestPath(path) ||
    isJvmTestPath(path)
  );
}

/**
 * JVM test conventions for Java and Kotlin, taken from the build tools' own
 * default class-name patterns — the JVM analog of Go's compiler-enforced
 * `_test.go`. These are what Maven Surefire/Failsafe (and, by convention, Gradle)
 * actually collect and run, matched on the class file's basename:
 * - Surefire (unit):        `Test*`, `*Test`, `*Tests`, `*TestCase`
 * - Failsafe (integration): `IT*`, `*IT`, `*ITCase`
 * - Kotlin (Kotest/Spek):   `*Spec` — the idiomatic Kotlin spec suffix
 *
 * Applied only to `.java` and `.kt` translation units. `.kts` (Gradle build
 * scripts such as `build.gradle.kts`) deliberately does NOT match. A test helper
 * or abstract base under `src/test/` that does not match these names is not a
 * runnable test on its own — a change to it still selects the tests that use it
 * through the dependents walk, exactly like conftest.py and Rust's `mod.rs`.
 *
 * Selection is at file granularity, but Gradle/Maven select tests by
 * fully-qualified class name, not path — so the runner recipe maps a selected
 * `src/test/{java,kotlin}/<pkg>/<Name>.<ext>` file back to `<pkg>.<Name>` for
 * `--tests` / `-Dtest` (see README).
 */
export function isJvmTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return (
    /^(Test|IT)[^/]*\.(java|kt)$/.test(base) ||
    /(Test|Tests|TestCase|IT|ITCase)\.(java|kt)$/.test(base) ||
    /Spec\.kt$/.test(base)
  );
}

/**
 * Rust's Cargo integration-test convention: a `.rs` file under a package-root
 * `tests/` directory. Cargo compiles `tests/<name>.rs` and `tests/<name>/main.rs`
 * as their own test binaries, and every other file in `tests/<name>/` is a module
 * of that binary — so file granularity is finer than target granularity, and the
 * runner recipe maps a selected file back to its target (see README).
 *
 * Deliberately NOT tests:
 * - `mod.rs` — the documented shared-helper form (`tests/common/mod.rs`) exists
 *   precisely so a helper is not compiled as its own target; it is the Rust
 *   analog of conftest.py. A change to one still selects the targets that
 *   include it, through the dependents walk.
 * - `src/tests/` — an in-crate unit-test module, not an integration target.
 * - `benches/` and `examples/` — different Cargo target kinds; a `#[test]` there
 *   does not run in `cargo test`'s default set.
 *
 * Rust UNIT tests have no path signature at all: they live inside the file they
 * cover as `#[cfg(test)] mod tests`, so the file under test IS the test file.
 * Path detection cannot find them and does not pretend to — the README states
 * what that means for selection.
 */
export function isRustTestPath(path: string): boolean {
  if (!path.endsWith(".rs")) return false;
  const segments = path.split("/");
  if (segments.pop() === "mod.rs") return false;
  const i = segments.indexOf("tests");
  if (i === -1) return false;
  if (i > 0 && segments[i - 1] === "src") return false;
  return !segments.includes("benches") && !segments.includes("examples");
}

/**
 * The absolute source_file paths of every test file in the graph. Selection is
 * reported at file granularity — that is what Vitest/Jest accept as arguments.
 */
export function testFiles(graph: CodeGraph): Set<string> {
  const files = new Set<string>();
  for (const n of graph.nodes) {
    if (n.source_file && isTestPath(n.source_file)) files.add(n.source_file);
  }
  return files;
}

/**
 * The fraction of non-test symbols forward-reachable from the repo's tests —
 * the graph-side answer to "can tests see the code at all?". A graph can pass
 * the edge-density floor and still be blind for selection when its test files
 * have no resolved edges into the implementation (measured: Go receiver-method
 * calls and Python imports/instantiations both extract that way today, at 0.11
 * and 0.07 coverage, versus 0.52-1.00 on healthy TS graphs). Returns null when
 * the graph has no test files or no non-test symbols — nothing to judge.
 */
export function testReachability(graph: CodeGraph): number | null {
  const outgoing = new Map<string, string[]>();
  for (const l of graph.links) {
    const [from, to] = dependencyDirection(l);
    const list = outgoing.get(from) ?? [];
    list.push(to);
    outgoing.set(from, list);
  }
  const seeds = graph.nodes
    .filter((n) => n.source_file && isTestPath(n.source_file))
    .map((n) => n.id);
  const targets = graph.nodes.filter(
    (n) => n.type !== "file" && n.source_file && !isTestPath(n.source_file),
  );
  if (seeds.length === 0 || targets.length === 0) return null;

  const seen = new Set(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  const reached = targets.filter((n) => seen.has(n.id)).length;
  return reached / targets.length;
}
