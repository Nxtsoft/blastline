import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexGraph, loadGraph, nodesInFile } from "./graph.js";
import { select } from "./select.js";

const FIXTURE = fileURLToPath(new URL("./testdata/seam-graph.json", import.meta.url));
const g = loadGraph(FIXTURE);

// A diff in the PROVIDER repo touching the schema's canonical file.
const PROVIDER_SCHEMA_DIFF = `diff --git a/src/schemas/score.ts b/src/schemas/score.ts
index 1..2 100644
--- a/src/schemas/score.ts
+++ b/src/schemas/score.ts
@@ -4,0 +5,1 @@
+  confidence: number;
`;

describe("cross-repo selection over a fused seam graph", () => {
  it("maps one changed provider file to both its code node and the schema contract node", () => {
    const nodes = nodesInFile(g, "src/schemas/score.ts");
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toContain("p_type");
    expect(ids).toContain("schema:ml-api:v3:ScoreResult");
  });

  it("selects the CONSUMER's test for a provider schema change, crossing the contract", () => {
    const sel = select(PROVIDER_SCHEMA_DIFF, { graph: g, minDensity: 0, minTestReachability: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    // schema -> endpoint (RESPONDS_WITH) -> consumer call site (CONSUMED_AT,
    // flipped) and mirror type (MIRRORED_BY, flipped) -> consumer test.
    expect(sel.tests).toEqual(["/svc/backend/src/score.test.ts"]);
    // The endpoint is crossed, not counted: a contract is no dependent code.
    expect(sel.blast.join("\n")).not.toContain("endpoint POST /v3/score");
    expect(sel.blast.join("\n")).toContain("function scoreModel");
  });

  it("a consumer-only change does not flow backwards into the provider", () => {
    const consumerDiff = `diff --git a/src/score.ts b/src/score.ts
index 1..2 100644
--- a/src/score.ts
+++ b/src/score.ts
@@ -5,0 +6,1 @@
+  // consumer tweak
`;
    const sel = select(consumerDiff, { graph: g, minDensity: 0, minTestReachability: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.tests).toEqual(["/svc/backend/src/score.test.ts"]);
    expect(sel.blast.join("\n")).not.toContain("service ml-api");
  });
});

describe("contracts in selection", () => {
  // A contract is minted where it is first seen, which can be a test file.
  const minted = indexGraph(
    [
      { id: "file_api", label: "src/api.ts", type: "file", source_file: "/r/src/api.ts" },
      { id: "fn_handler", label: "getReport", type: "function", source_file: "/r/src/api.ts", source_location: { start_line: 1, end_line: 5 } },
      { id: "file_api_test", label: "src/api.test.ts", type: "file", source_file: "/r/src/api.test.ts" },
      { id: "endpoint:GET /report", label: "GET /report", type: "endpoint", source_file: "/r/src/api.test.ts", source_location: { start_line: 3, end_line: 3 } },
    ],
    [
      { source: "file_api", target: "fn_handler", relation: "contains" },
      { source: "endpoint:GET /report", target: "fn_handler", relation: "handled_by" },
    ],
  );
  const diff = `diff --git a/src/api.ts b/src/api.ts
index 1..2 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -2,0 +3,1 @@
+  // tweak
`;

  it("keeps the test file a contract was minted in, and counts no contract as a dependent", () => {
    const sel = select(diff, { graph: minted, minDensity: 0, minTestReachability: 0 });
    expect(sel.kind).toBe("subset");
    if (sel.kind !== "subset") return;
    expect(sel.tests).toEqual(["/r/src/api.test.ts"]);
    expect(sel.blast.join("\n")).not.toContain("GET /report");
  });
});
