import { describe, expect, it } from "vitest";
import { badgeFromLedger, computeAudit } from "./audit.js";
import type { AuditRecord } from "./audit.js";
import type { Selection } from "./types.js";

const subset = (tests: string[]): Selection => ({ kind: "subset", tests, blast: [] });

describe("computeAudit", () => {
  it("a failing test outside the subset is an escape", () => {
    const out = computeAudit(subset(["/repo/src/a.test.ts"]), ["/repo/src/b.test.ts"]);
    expect(out.verdict).toBe("escape");
    expect(out.escapes).toEqual(["/repo/src/b.test.ts"]);
  });

  it("failures fully inside the subset are caught", () => {
    const out = computeAudit(subset(["/repo/src/a.test.ts", "/repo/src/b.test.ts"]), [
      "/repo/src/b.test.ts",
    ]);
    expect(out).toEqual({ escapes: [], verdict: "caught" });
  });

  it("a green full suite under a subset is clean", () => {
    expect(computeAudit(subset(["/repo/src/a.test.ts"]), [])).toEqual({
      escapes: [],
      verdict: "clean",
    });
  });

  it("fail-open selections cannot have escapes by definition", () => {
    const all: Selection = { kind: "all", reasons: [{ kind: "unmapped-file", path: "x" }] };
    expect(computeAudit(all, ["/repo/src/a.test.ts"])).toEqual({
      escapes: [],
      verdict: "full-run",
    });
  });

  it("membership tolerates reporter path normalization differences", () => {
    // vitest may report repo-relative paths while selection carries absolutes.
    const out = computeAudit(subset(["/repo/src/a.test.ts"]), ["src/a.test.ts"]);
    expect(out.verdict).toBe("caught");
  });
});

describe("badgeFromLedger", () => {
  const rec = (escapes: string[]): AuditRecord => ({
    range: "a..b",
    headSha: "b",
    kind: "subset",
    verdict: escapes.length > 0 ? "escape" : "clean",
    totalTests: 10,
    failed: escapes,
    escapes,
  });

  it("stays green while no escape has ever been recorded", () => {
    const badge = badgeFromLedger([rec([]), rec([])]);
    expect(badge.message).toBe("0 in 2 audited merges");
    expect(badge.color).toBe("brightgreen");
  });

  it("turns red on the first escape and counts it", () => {
    const badge = badgeFromLedger([rec([]), rec(["/repo/src/x.test.ts"])]);
    expect(badge.message).toBe("1 in 2 audited merges");
    expect(badge.color).toBe("red");
  });
});
