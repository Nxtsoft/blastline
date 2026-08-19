import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGraph, nodesForPath } from "./graph.js";
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
    const nodes = nodesForPath(g, "src/schemas/score.ts");
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
    expect(sel.blast.join("\n")).toContain("endpoint POST /v3/score");
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
