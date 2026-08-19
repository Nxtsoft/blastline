import type { Selection } from "./types.js";

/** Render a selection as the PR-comment markdown the GitHub Action posts. */
export function renderComment(selection: Selection, range: string): string {
  const header = `### blastline — test impact for \`${range}\``;
  if (selection.kind === "all") {
    const reasons = selection.reasons
      .map((r) => {
        switch (r.kind) {
          case "unmapped-file":
            return `- \`${r.path}\` has no graph node (config/asset/unextracted file)`;
          case "stale-graph":
            return `- graph is stale: expected ${r.expected}, got ${r.actual}`;
          case "sparse-graph":
            return `- graph looks under-extracted: ${r.edgesPerFile} edges/file (floor ${r.threshold})`;
          case "disconnected-tests":
            return `- tests can reach only ${Math.round(r.coverage * 100)}% of the code in the graph (floor ${Math.round(r.threshold * 100)}%) — selection would be blind`;
          case "diff-too-large":
            return `- diff touches ${r.files} files (limit ${r.limit})`;
          case "extraction-warning":
            return `- extraction warning on \`${r.path}\``;
          case "graph-unavailable":
            return `- ${r.detail}`;
        }
      })
      .join("\n");
    return `${header}\n\n**Run the full suite** — the graph cannot vouch for this diff:\n\n${reasons}\n`;
  }
  const tests =
    selection.tests.length > 0
      ? selection.tests.map((t) => `- \`${t}\``).join("\n")
      : "_none — no test file depends on the changed code_";
  const blast =
    selection.blast.length > 0
      ? `<details><summary>Blast radius (${selection.blast.length} dependents)</summary>\n\n${selection.blast
          .map((b) => `- ${b}`)
          .join("\n")}\n\n</details>`
      : "_no downstream dependents_";
  return `${header}\n\n**Impacted tests (run at least these):**\n\n${tests}\n\n${blast}\n`;
}
