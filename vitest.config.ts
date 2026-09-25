import { defineConfig } from "vitest/config";

// .agents/ holds agent worktrees and scratch checkouts of this same repo;
// without the exclusion every checkout's tests run again under this one.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", ".agents/**"] },
});
