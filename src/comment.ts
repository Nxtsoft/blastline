import { relativeTo, sharedDir } from "./paths.js";
import type { ChangedFileImpact, FailOpenReason, Selection } from "./types.js";

/** First line of every comment: the Action finds and updates the existing comment by it. */
export const COMMENT_MARKER = "<!-- blastline:test-impact -->";

export interface CommentContext {
  /** The range as given, e.g. `main..HEAD`; shown only when the shas could not be resolved. */
  range: string;
  /** Absolute repo root; graph paths are shown relative to it. */
  repo: string;
  /** Short shas of the two ends of the range, when resolved. */
  baseSha?: string;
  headSha?: string;
  /** `https://github.com/owner/repo`: turns paths into blob links and the shas into a compare link. */
  repoUrl?: string;
  prNumber?: number;
  /** Hosted reach figure, one URL per theme. */
  figure?: { dark: string; light: string };
  /** blastline version, for the footer. */
  version: string;
}

const README = "https://github.com/Nxtsoft/blastline#how-selection-works";

function code(s: string): string {
  return `\`${s}\``;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A 20-cell bar for a fraction, as text GitHub renders in any client. */
function bar(part: number, whole: number): string {
  if (whole === 0) return "";
  const filled = part === 0 ? 0 : Math.max(1, Math.round((part / whole) * 20));
  return code("▮".repeat(filled) + "▯".repeat(20 - filled));
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

function shortSha(sha: string): string {
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha;
}

class Links {
  constructor(private readonly ctx: CommentContext) {}
  /** A repo-relative path, linked to its blob at head when the repo URL and head sha are known. */
  path(rel: string, text = rel): string {
    const { repoUrl, headSha } = this.ctx;
    return repoUrl && headSha ? `[${code(text)}](${repoUrl}/blob/${headSha}/${rel})` : code(text);
  }
  compare(): string | undefined {
    const { repoUrl, baseSha, headSha } = this.ctx;
    if (!baseSha || !headSha) return undefined;
    const head = code(shortSha(headSha));
    return repoUrl ? `[${head}](${repoUrl}/compare/${baseSha}...${headSha})` : head;
  }
}

/** Sort the mapped rows by tests reached, then reach, so the widest change reads first. */
function byImpact(a: ChangedFileImpact, b: ChangedFileImpact): number {
  return b.tests.length - a.tests.length || b.reaches.length - a.reaches.length || a.path.localeCompare(b.path);
}

function symbolsCell(symbols: string[], limit = 3): string {
  if (symbols.length === 0) return "whole file";
  const shown = symbols.slice(0, limit).map(code).join(", ");
  return symbols.length > limit ? `${shown}, +${symbols.length - limit}` : shown;
}

/** Rows for ignored files, grouped by top-level directory so ten spec files are one line. */
function ignoredRows(files: ChangedFileImpact[]): string[] {
  const topOf = (path: string): string => (path.includes("/") ? (path.split("/")[0] as string) : ".");
  const byTop = new Map<string, string[]>();
  for (const f of files) byTop.set(topOf(f.path), [...(byTop.get(topOf(f.path)) ?? []), f.path]);
  return [...byTop.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([top, paths]) => {
      const what = paths.length === 1 ? code(paths[0] as string) : `${plural(paths.length, "file")} under ${code(top === "." ? "the repo root" : `${top}/`)}`;
      return `| ${what} | ignored by policy | | 0 |`;
    });
}

function renderSubset(selection: Extract<Selection, { kind: "subset" }>, ctx: CommentContext): string {
  const links = new Links(ctx);
  const mapped = selection.files.filter((f) => f.disposition === "mapped");
  const ignored = selection.files.filter((f) => f.disposition === "ignored");
  const symbolTotal = mapped.reduce((n, f) => n + f.symbols.length, 0);
  const reachedFiles = new Set<string>();
  for (const f of mapped) for (const r of f.reaches) reachedFiles.add(r.file);
  const n = selection.tests.length;
  const header = `### Test impact: ${n} of ${plural(selection.testsTotal, "test file")} reach${n === 1 ? "es" : ""} this diff`;
  const lead =
    n > 0
      ? "**Run at least these.** Selection is a safe superset; it never marks a test safe to skip."
      : "**No test file depends on the changed code.** Selection is a safe superset; it never marks a test safe to skip.";

  const at = links.compare();
  const summaryTitle = ctx.prNumber !== undefined && at ? `PR #${ctx.prNumber} at ${at}` : at ? `at ${at}` : code(ctx.range);
  const changedCell = [
    `${plural(selection.files.length, "file")}: ${mapped.length} mapped to ${plural(symbolTotal, "symbol")}`,
    ignored.length > 0 ? `${ignored.length} ignored by policy` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const summary = [
    `| Summary | ${summaryTitle} |`,
    "|---|---|",
    `| Changed | ${changedCell} |`,
    `| Tests reached | **${n}** of ${selection.testsTotal} ${bar(n, selection.testsTotal)} ${percent(n, selection.testsTotal)} of the suite |`,
    `| Downstream code | ${plural(reachedFiles.size, "file")}, ${plural(selection.blast.length, "dependent")} |`,
    ctx.baseSha ? `| Compared against | base ${code(shortSha(ctx.baseSha))} |` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const figure = ctx.figure
    ? `<picture><source media="(prefers-color-scheme: dark)" srcset="${ctx.figure.dark}"><img alt="Reach graph: ${mapped.length} changed files reach ${reachedFiles.size} files and ${n} of ${selection.testsTotal} tests" src="${ctx.figure.light}" width="940"></picture>`
    : "";

  const prefix = sharedDir(mapped.map((f) => f.path));
  const short = (rel: string): string => (prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
  const isTestFile = (f: ChangedFileImpact): boolean => f.tests.some((t) => t.endsWith(`/${f.path}`) || t === f.path);
  const rows = [
    "| Changed file | Symbols touched | Reaches | Tests |",
    "|---|---|---:|---:|",
    ...[...mapped].sort(byImpact).map((f) => {
      const name = links.path(f.path, short(f.path)) + (f.status === "added" ? " (new)" : f.status === "deleted" ? " (deleted)" : "");
      const what = isTestFile(f) ? "test code, selected directly" : symbolsCell(f.symbols);
      const reaches = f.reaches.length === 0 ? "" : plural(f.reaches.length, "file");
      return `| ${name} | ${what} | ${reaches} | ${f.tests.length} |`;
    }),
    ...ignoredRows(ignored),
  ].join("\n");
  const prefixNote = prefix ? `Paths above are under ${code(prefix)} unless shown in full.` : "";

  const tests =
    n > 0
      ? selection.tests.map((t) => `- ${links.path(relativeTo(ctx.repo, t))}`).join("\n")
      : "_none: no test file depends on the changed code_";

  const blast =
    selection.blast.length > 0
      ? [
          `<details><summary>Blast radius by changed file: ${plural(selection.blast.length, "dependent")}</summary>`,
          "",
          ...[...mapped]
            .sort(byImpact)
            .filter((f) => f.reaches.length > 0)
            .map((f) => {
              const parts = f.reaches.slice(0, 6).map((r) => {
                const rel = relativeTo(ctx.repo, r.file);
                const syms = r.symbols.slice(0, 3).map(code).join(", ");
                const more = r.symbols.length > 3 ? `, +${r.symbols.length - 3}` : "";
                return syms ? `${syms}${more} (${links.path(rel, short(rel))})` : links.path(rel, short(rel));
              });
              const rest = f.reaches.length > 6 ? `, +${plural(f.reaches.length - 6, "file")}` : "";
              return `- ${code(short(f.path))} reaches ${parts.join(", ")}${rest}`;
            }),
          "",
          "</details>",
        ].join("\n")
      : "_no downstream dependents_";

  return [
    COMMENT_MARKER,
    header,
    "",
    lead,
    "",
    summary,
    "",
    figure,
    figure ? "" : undefined,
    "#### What each changed file reaches",
    "",
    rows,
    "",
    prefixNote,
    prefixNote ? "" : undefined,
    `#### Tests to run (${n})`,
    "",
    tests,
    "",
    blast,
    "",
    footer(selection.contentRoot, ctx),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function footer(contentRoot: string | undefined, ctx: CommentContext): string {
  const graph = contentRoot ? ` Graph ${code(contentRoot.slice(0, 7))}.` : "";
  return `<sub>blastline ${ctx.version}. Selection is advisory unless your workflow gates on it. [How selection works](${README}).${graph}</sub>`;
}

/** Each fail-open reason, as the cause and the one thing the reader can do about it. */
function explain(r: Exclude<FailOpenReason, { kind: "unmapped-file" }>): [why: string, action: string] {
  switch (r.kind) {
    case "stale-graph":
      return [`Graph is stale: expected ${r.expected}, got ${r.actual}`, "Rebuild the graph after the head commit. With `graph-root`, the Action rebuilds on the next run."];
    case "sparse-graph":
      return [`Graph looks under-extracted: ${r.edgesPerFile} edges per file (floor ${r.threshold})`, "Check that cgraph extracted the repo's languages; a graph this sparse is missing edges, and a subset from it would be blind."];
    case "disconnected-tests":
      return [`Tests can reach only ${Math.round(r.coverage * 100)}% of the code in the graph (floor ${Math.round(r.threshold * 100)}%)`, "Tests have no resolved edges into the implementation. Check extraction for the test files' language and the test conventions blastline detects."];
    case "no-test-files":
      return ["The graph contains no test files at all", "No file matched a test convention blastline knows (JS/TS, pytest, Go, C/C++, Cargo, JVM). Selection would have to answer \"none\", which is not the same as \"no tests are affected\"."];
    case "selection-saturated":
      return [`Selection reached ${r.selected} of ${r.total} tests (${Math.round(r.threshold * 100)}% or more)`, "Nothing to fix: running everything is the same work, and an honest description of it."];
    case "traversal-exhausted":
      return [`The dependency walk exceeded its budget (${r.visited} nodes, limit ${r.budget})`, "Raise `--max-traversal-nodes`, or split the change. A partially walked graph cannot name every impacted test."];
    case "diff-too-large":
      return [`Diff touches ${r.files} files (limit ${r.limit})`, "Raise `--max-files` or split the change."];
    case "extraction-warning":
      return [`cgraph warned while extracting ${code(r.path)}`, "Rebuild the graph and inspect that file; a warning means its edges may be incomplete."];
    case "graph-unavailable":
      return [r.detail, "Build the graph with `graph-root`, or point `graph-path` at an existing graph.json."];
    case "invalid-ignore-pattern":
      return [`${code("--ignore")} pattern ${code(r.pattern)} is not a valid regex (${r.detail})`, "`--ignore` takes regexes, not globs. Fix the pattern."];
    default: {
      // A new FailOpenReason must render here; without this the switch falls
      // through to undefined and the PR comment prints "undefined".
      const unhandled: never = r;
      return unhandled;
    }
  }
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
  const listed = paths.slice(0, 50).join("\n");
  const more = paths.length > 50 ? `\n… ${paths.length - 50} more` : "";
  return [
    `**${paths.length} file${paths.length === 1 ? " has" : "s have"} no graph node** (config, asset, or unextracted).`,
    "",
    "If these files cannot change which tests should run, add a pattern for them to `ignore`. If they feed tests (fixtures, data), this outcome is correct.",
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

function renderAll(selection: Extract<Selection, { kind: "all" }>, ctx: CommentContext): string {
  const links = new Links(ctx);
  const unmapped = selection.reasons.filter((r) => r.kind === "unmapped-file").map((r) => r.path);
  const others = selection.reasons.filter(
    (r): r is Exclude<FailOpenReason, { kind: "unmapped-file" }> => r.kind !== "unmapped-file",
  );
  const at = links.compare();
  const where = at ? `Computed at ${at}${ctx.baseSha ? ` against base ${code(shortSha(ctx.baseSha))}` : ""}.` : `Range ${code(ctx.range)}.`;
  const table =
    others.length > 0
      ? ["| Why | What you can do |", "|---|---|", ...others.map((r) => `| ${explain(r).join(" | ")} |`)].join("\n")
      : "";
  return [
    COMMENT_MARKER,
    "### Test impact: run the full suite",
    "",
    "> [!WARNING]",
    "> The graph cannot vouch for this diff, so every test file is selected. Nothing is skipped; this is the safe default, not a failure.",
    "",
    table,
    table ? "" : undefined,
    unmapped.length > 0 ? renderUnmapped(unmapped) : undefined,
    unmapped.length > 0 ? "" : undefined,
    where,
    "",
    footer(undefined, ctx),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** Render a selection as the PR-comment markdown the GitHub Action posts. */
export function renderComment(selection: Selection, ctx: CommentContext): string {
  return selection.kind === "all" ? renderAll(selection, ctx) : renderSubset(selection, ctx);
}
