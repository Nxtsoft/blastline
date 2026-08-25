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
          case "invalid-ignore-pattern":
            return `- \`--ignore\` pattern \`${r.pattern}\` is not a valid regex (${r.detail}) — \`--ignore\` takes regexes, not globs`;
          default: {
            // A new FailOpenReason must render here; without this the switch
            // falls through to undefined and the PR comment prints "undefined".
            const unhandled: never = r;
            return unhandled;
          }
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
  const provenance =
    selection.contentRoot !== undefined
      ? `\n<sub>computed from source tree \`sha256-merkle-v1:${selection.contentRoot}\`</sub>\n`
      : "";
  return `${header}\n\n**Impacted tests (run at least these):**\n\n${tests}\n\n${blast}\n${provenance}`;
}
