import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTestPath, testFiles, testReachability } from "./detect.js";
import { loadGraph } from "./graph.js";

const FIXTURE = fileURLToPath(new URL("./testdata/mini-graph.json", import.meta.url));

describe("isTestPath", () => {
  it("matches Vitest/Jest conventions", () => {
    expect(isTestPath("src/lib.test.ts")).toBe(true);
    expect(isTestPath("src/Thing.spec.tsx")).toBe(true);
    expect(isTestPath("src/__tests__/thing.ts")).toBe(true);
    expect(isTestPath("a/b.test.mjs")).toBe(true);
  });

  it("matches pytest collection defaults", () => {
    expect(isTestPath("tests/test_core.py")).toBe(true);
    expect(isTestPath("pkg/core_test.py")).toBe(true);
    expect(isTestPath("test_top_level.py")).toBe(true);
  });

  it("matches Go's compiler-enforced convention", () => {
    expect(isTestPath("pkg/core_test.go")).toBe(true);
    expect(isTestPath("core_test.go")).toBe(true);
  });

  it("matches C/C++ googletest/ctest conventions", () => {
    expect(isTestPath("tests/smoke/cpp_extractor_test.cpp")).toBe(true);
    expect(isTestPath("src/engine/graph_builder_test.cc")).toBe(true);
    expect(isTestPath("lib/parse_test.cxx")).toBe(true);
    expect(isTestPath("core/ring_buffer_test.c")).toBe(true);
    expect(isTestPath("tests/test_pipeline.cpp")).toBe(true);
  });

  it("matches Rust's Cargo integration-test convention", () => {
    expect(isTestPath("tests/tests.rs")).toBe(true); // tests/<name>.rs is its own target
    expect(isTestPath("tests/builder/flags.rs")).toBe(true); // module of the "builder" target
    expect(isTestPath("tests/builder/main.rs")).toBe(true); // the target's root file
    expect(isTestPath("clap_complete/tests/examples.rs")).toBe(true); // workspace member package
    expect(isTestPath("crates/core/tests/integration.rs")).toBe(true);
  });

  it("does not match Rust non-test Cargo target kinds", () => {
    expect(isTestPath("benches/bench.rs")).toBe(false); // cargo bench, not cargo test
    expect(isTestPath("benches/tests/util.rs")).toBe(false);
    expect(isTestPath("examples/simple.rs")).toBe(false);
    expect(isTestPath("examples/tests/demo.rs")).toBe(false);
    expect(isTestPath("tests/testenv/mod.rs")).toBe(false); // shared-helper convention
    expect(isTestPath("tests/common/mod.rs")).toBe(false);
    expect(isTestPath("src/tests/parser.rs")).toBe(false); // in-crate unit module, no target
    expect(isTestPath("src/walk.rs")).toBe(false); // #[cfg(test)] mod tests has no path signature
    expect(isTestPath("attests/thing.rs")).toBe(false);
    expect(isTestPath("tests/fixtures/input.txt")).toBe(false);
    expect(isTestPath("tests")).toBe(false);
  });

  it("matches JVM JUnit conventions (Surefire/Failsafe + Kotest)", () => {
    expect(isTestPath("src/test/java/com/x/CalculatorTest.java")).toBe(true); // *Test
    expect(isTestPath("src/test/kotlin/com/x/PaymentTests.kt")).toBe(true); // *Tests
    expect(isTestPath("src/test/java/com/x/WidgetTestCase.java")).toBe(true); // *TestCase
    expect(isTestPath("app/src/test/java/com/x/TestRunner.java")).toBe(true); // Surefire Test* prefix
    expect(isTestPath("src/integ/PaymentIT.java")).toBe(true); // Failsafe *IT
    expect(isTestPath("src/integ/BillingITCase.java")).toBe(true); // Failsafe *ITCase
    expect(isTestPath("src/integ/ITWorkflow.kt")).toBe(true); // Failsafe IT* prefix
    expect(isTestPath("src/test/kotlin/com/x/CalculatorSpec.kt")).toBe(true); // Kotest/Spek *Spec.kt
  });

  it("does not match JVM non-tests", () => {
    expect(isTestPath("build.gradle.kts")).toBe(false); // Gradle script, not a .kt unit
    expect(isTestPath("settings.gradle.kts")).toBe(false);
    expect(isTestPath("src/main/java/com/x/Calculator.java")).toBe(false); // production source
    expect(isTestPath("src/main/kotlin/com/x/Payment.kt")).toBe(false);
    expect(isTestPath("src/main/java/com/x/Latest.java")).toBe(false); // "test" only lowercase
    expect(isTestPath("src/main/kotlin/com/x/GreatestHits.kt")).toBe(false);
    expect(isTestPath("src/main/java/com/x/Attest.java")).toBe(false); // "attest", not a Test suffix
    expect(isTestPath("src/test/resources/TestData.json")).toBe(false); // fixture, not .java/.kt
    expect(isTestPath("CalculatorSpec.java")).toBe(false); // *Spec is a Kotlin-only signal
  });

  it("does not match near-misses", () => {
    expect(isTestPath("src/latest.ts")).toBe(false);
    expect(isTestPath("src/contest.spec/readme.ts")).toBe(false);
    expect(isTestPath("src/test/helpers.ts")).toBe(false); // plain "test" dir is not __tests__
    expect(isTestPath("src/protest.ts")).toBe(false);
    expect(isTestPath("tests/conftest.py")).toBe(false); // fixtures, not tests
    expect(isTestPath("tests/helpers.py")).toBe(false); // tests/ dir alone is no signal
    expect(isTestPath("pkg/attest.py")).toBe(false);
    expect(isTestPath("pkg/latest.go")).toBe(false);
    expect(isTestPath("pkg/contest.go")).toBe(false);
    expect(isTestPath("tests/fuzz/extractor_fuzzer.cpp")).toBe(false); // fuzz harness, not a test
    expect(isTestPath("src/latest.cpp")).toBe(false);
    expect(isTestPath("include/graph_test.h")).toBe(false); // headers are shared fixtures
    expect(isTestPath("src/contest.cc")).toBe(false);
  });
});

describe("testFiles", () => {
  it("collects test file paths from the graph", () => {
    expect(testFiles(loadGraph(FIXTURE))).toEqual(new Set(["/repo/src/lib.test.ts"]));
  });
});

describe("testReachability", () => {
  it("measures the fraction of non-test symbols reachable from tests", () => {
    // f_test -> fn_parse (imports) and -> f_lib (imports_from) -> contains all
    // three lib symbols; fn_use (the consumer) is upstream and unreachable.
    expect(testReachability(loadGraph(FIXTURE))).toBeCloseTo(3 / 4);
  });

  it("returns null when the graph has no test files", () => {
    const g = loadGraph(FIXTURE);
    const stripped = {
      ...g,
      nodes: g.nodes.filter((n) => !n.source_file?.includes("test")),
    };
    expect(testReachability(stripped)).toBeNull();
  });
});
