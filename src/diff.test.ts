import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";

const MODIFIED = `diff --git a/src/score.ts b/src/score.ts
index 111..222 100644
--- a/src/score.ts
+++ b/src/score.ts
@@ -41,0 +42,3 @@ export function scoreModel() {
+  const x = 1;
+  const y = 2;
+  return x + y;
@@ -60,2 +63,0 @@ function helper() {
-  old();
-  lines();
`;

const ADDED_AND_DELETED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 444..000
--- a/src/gone.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-1
-2
-3
-4
-5
`;

const RENAMED = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -10 +10 @@
-const v = 1;
+const v = 2;
`;

describe("parseUnifiedDiff", () => {
  it("maps addition and pure-deletion hunks to the correct sides", () => {
    const files = parseUnifiedDiff(MODIFIED);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe("src/score.ts");
    expect(file.status).toBe("modified");
    // Hunk 1: 3 lines added at new-side 42-44.
    expect(file.ranges[0]).toEqual({ start: 42, end: 44, deletion: false });
    // Hunk 2: pure deletion anchored to old-side 60-61.
    expect(file.ranges[1]).toEqual({ start: 60, end: 61, deletion: true });
  });

  it("classifies added and deleted files, anchoring deletions to the old path", () => {
    const files = parseUnifiedDiff(ADDED_AND_DELETED);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "src/new.ts", status: "added" });
    expect(files[0]!.ranges[0]).toEqual({ start: 1, end: 2, deletion: false });
    expect(files[1]).toMatchObject({ path: "src/gone.ts", status: "deleted" });
    expect(files[1]!.ranges[0]).toEqual({ start: 1, end: 5, deletion: true });
  });

  it("handles renames and count-omitted single-line hunks", () => {
    const files = parseUnifiedDiff(RENAMED);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("src/old-name.ts");
    expect(file.path).toBe("src/new-name.ts");
    // "@@ -10 +10 @@" omits counts entirely; both default to 1.
    expect(file.ranges[0]).toEqual({ start: 10, end: 10, deletion: false });
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
