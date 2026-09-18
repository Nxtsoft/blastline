import type { FailOpenReason, Selection } from "./types.js";

/** Reasons rendered one-per-line; every other kind is naturally low-cardinality. */
function renderReason(r: Exclude<FailOpenReason, { kind: "unmapped-file" }>): string {
  switch (r.kind) {
    case "stale-graph":
      return `graph is stale: expected ${r.expected}, got ${r.actual}`;
    case "sparse-graph":
      return `graph looks under-extracted: ${r.edgesPerFile} edges/file (floor ${r.threshold})`;
    case "disconnected-tests":
      return `tests can reach only ${Math.round(r.coverage * 100)}% of the code in the graph (floor ${Math.round(r.threshold * 100)}%) — selection would be blind`;
    case "no-test-files":
      return `the graph contains no test files at all — selection would have to answer "none", which is not the same as "no tests are affected"`;
    case "selection-saturated":
      return `selection reached ${r.selected} of ${r.total} tests (${Math.round(r.threshold * 100)}% or more) — running everything is the same work, and an honest description of it`;
    case "traversal-exhausted":
      return `the dependency walk exceeded its budget (${r.visited} nodes, limit ${r.budget}) — a partially walked graph cannot be trusted to name every impacted test`;
    case "diff-too-large":
      return `diff touches ${r.files} files (limit ${r.limit})`;
    case "extraction-warning":
      return `extraction warning on \`${r.path}\``;
    case "graph-unavailable":
      return r.detail;
    case "invalid-ignore-pattern":
      return `\`--ignore\` pattern \`${r.pattern}\` is not a valid regex (${r.detail}) — \`--ignore\` takes regexes, not globs`;
    default: {
      // A new FailOpenReason must render here; without this the switch falls
      // through to undefined and the PR comment prints "undefined".
      const unhandled: never = r;
      return unhandled;
    }
  }
}

/** Longest directory shared by every path, so the histogram starts where they diverge. */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

/**
 * One `unmapped-file` reason per file made the comment unreadable: a real PR
 * produced ~900 near-identical bullets, burying the verdict and every other
 * reason under them. The paths still matter, so they are grouped by directory
 * with counts and kept in full behind a fold, rather than dropped.
 */
function renderUnmapped(paths: string[]): string {
  const byDir = new Map<string, number>();
  for (const p of paths) byDir.set(dirOf(p), (byDir.get(dirOf(p)) ?? 0) + 1);
  const rows = [...byDir.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = rows.slice(0, 5);
  const width = Math.max(...top.map(([d]) => d.length));
  const max = top[0]?.[1] ?? 1;
  const bars = top
    .map(([dir, n]) => {
      const filled = Math.max(1, Math.round((n / max) * 24));
      return `${dir.padEnd(width)}  ${"█".repeat(filled)}  ${n}`;
    })
    .join("\n");
  const rest = rows.length > top.length ? `\n_and ${rows.length - top.length} more directories_\n` : "";
  const listed = paths.slice(0, 50).map((p) => p).join("\n");
  const more = paths.length > 50 ? `\n… ${paths.length - 50} more` : "";
  return [
    `**${paths.length} file${paths.length === 1 ? " has" : "s have"} no graph node** (config / asset / unextracted).`,
    "",
    "```",
    bars,
    "```",
    rest,
    `<details><summary>All ${paths.length} unmapped file${paths.length === 1 ? "" : "s"}</summary>`,
    "",
    "```",
    listed + more,
    "```",
    "",
    "</details>",
  ].join("\n");
}

/** Render a selection as the PR-comment markdown the GitHub Action posts. */
export function renderComment(selection: Selection, range: string): string {
  if (selection.kind === "all") {
    const unmapped = selection.reasons.filter((r) => r.kind === "unmapped-file").map((r) => r.path);
    const others = selection.reasons.filter(
      (r): r is Exclude<FailOpenReason, { kind: "unmapped-file" }> => r.kind !== "unmapped-file",
    );
    const header = `### blastline — run the full suite`;
    const summary = [
      "| | |",
      "|---|---|",
      "| **Verdict** | Run the full suite |",
      `| **Blocking reasons** | ${selection.reasons.length} |`,
      `| **Range** | \`${range}\` |`,
    ].join("\n");
    const bullets = others.map((r) => `- ${renderReason(r)}`).join("\n");
    const blocks = [header, "", "The graph cannot vouch for this diff.", "", summary, ""];
    if (bullets.length > 0) blocks.push(bullets, "");
    if (unmapped.length > 0) blocks.push(renderUnmapped(unmapped), "");
    return blocks.join("\n");
  }
  const header = `### blastline — ${selection.tests.length} test${selection.tests.length === 1 ? "" : "s"} selected`;
  const summary = [
    "| | |",
    "|---|---|",
    `| **Verdict** | ${selection.tests.length > 0 ? `Run at least these ${selection.tests.length}` : "No test file depends on the changed code"} |`,
    `| **Blast radius** | ${selection.blast.length} dependent${selection.blast.length === 1 ? "" : "s"} |`,
    `| **Range** | \`${range}\` |`,
  ].join("\n");
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
  return `${header}\n\n${summary}\n\n**Impacted tests (run at least these):**\n\n${tests}\n\n${blast}\n${provenance}`;
}
