import type { Checkpoint, SymbolReason } from "./checkpoint.js";
import { TEST_RUNNER } from "./checkpoint.js";
import type { Brief, ClaimCheck, CommitBrief, SymbolChange } from "./brief.js";
import { SNAPSHOT_MARKER } from "./brief.js";
import { relativeTo, sharedDir } from "./paths.js";
import type { ChangedFileImpact, FileEdge, FailOpenReason, Selection } from "./types.js";

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
  /**
   * The reach figure: a hosted image (one URL per theme), or a mermaid block
   * GitHub draws itself, which is what a private repository needs since its
   * images cannot be fetched anonymously.
   */
  figure?: { kind: "image"; dark: string; light: string } | { kind: "mermaid"; source: string };
  /** blastline version, for the footer. */
  version: string;
}

const README = "https://github.com/Nxtsoft/blastline#how-selection-works";
const BRIEF_README = "https://github.com/Nxtsoft/blastline#pr-brief";

/** Commit rows beyond this fold behind a summary; a long PR must not bury the claims. */
export const COMMIT_ROWS_UNFOLDED = 10;

function code(s: string): string {
  return `\`${s}\``;
}

/** Table cells split at `|`, even inside a code span; GFM accepts `\|` as a literal pipe. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
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
  commit(sha: string): string {
    const { repoUrl } = this.ctx;
    const short = code(shortSha(sha));
    return repoUrl ? `[${short}](${repoUrl}/commit/${sha})` : short;
  }
}

/** Sort the mapped rows by tests reached, then reach, so the widest change reads first. */
function byImpact(a: ChangedFileImpact, b: ChangedFileImpact): number {
  return b.tests.length - a.tests.length || b.reaches.length - a.reaches.length || a.path.localeCompare(b.path);
}

/** A changed file the test walk selected directly: its own path is among its reached tests. */
function isTestFile(f: ChangedFileImpact): boolean {
  return f.tests.some((t) => t.endsWith(`/${f.path}`) || t === f.path);
}

/**
 * The order to read the changed files in: the widest change first, and a
 * changed file that another changed file reaches (it depends on that change)
 * right after the file it depends on, marked with it, so the reviewer meets a
 * cause before its dependents. Test files, selected directly, come last.
 * Reviewers comment less on each file the further down a list it sits
 * (Rahman, Codabux, Roy 2026: about 8.7% lower odds per extra file), so the
 * order carries the reach, not the alphabet.
 */
export function readingOrder(mapped: ChangedFileImpact[], edges: FileEdge[], repo: string): { file: ChangedFileImpact; after?: ChangedFileImpact }[] {
  const changedCode = [...mapped].filter((f) => !isTestFile(f)).sort(byImpact);
  const tests = [...mapped].filter(isTestFile).sort(byImpact);
  // A per-file walk never lists another changed file among its reaches (the
  // diff already covers it), so the changed-to-changed dependencies come from
  // the file edges: `to` depends on `from`.
  const dependentsOf = new Map<string, Set<string>>();
  for (const e of edges) {
    const from = relativeTo(repo, e.from);
    dependentsOf.set(from, (dependentsOf.get(from) ?? new Set()).add(relativeTo(repo, e.to)));
  }
  const placed = new Set<ChangedFileImpact>();
  const out: { file: ChangedFileImpact; after?: ChangedFileImpact }[] = [];
  const place = (f: ChangedFileImpact, after?: ChangedFileImpact): void => {
    if (placed.has(f)) return;
    placed.add(f);
    out.push(after ? { file: f, after } : { file: f });
    const reached = dependentsOf.get(f.path) ?? new Set<string>();
    for (const dependent of changedCode) if (!placed.has(dependent) && reached.has(dependent.path)) place(dependent, f);
  };
  for (const f of changedCode) place(f);
  for (const f of tests) place(f);
  return out;
}

/**
 * A coarse tier for how much reviewing the change asks for, from what the
 * graph already measured: `high` from 20 dependents or 10 mapped files, `low`
 * under 5 dependents and 4 files, `medium` between. Fixed thresholds, stated
 * next to the numbers they come from; structure predicts review effort better
 * than the change's own description (Minh et al., MSR'26).
 */
export function reviewEffort(dependents: number, mappedFiles: number): "low" | "medium" | "high" {
  if (dependents >= 20 || mappedFiles >= 10) return "high";
  if (dependents < 5 && mappedFiles < 4) return "low";
  return "medium";
}

function symbolsCell(symbols: string[], limit = 3): string {
  if (symbols.length === 0) return "whole file";
  const shown = symbols.slice(0, limit).map(code).join(", ");
  return symbols.length > limit ? `${shown}, +${symbols.length - limit}` : shown;
}

/** Rows for ignored files, grouped by top-level directory so ten spec files are one line. */
function ignoredRows(files: ChangedFileImpact[], why = false): string[] {
  const topOf = (path: string): string => (path.includes("/") ? (path.split("/")[0] as string) : ".");
  const byTop = new Map<string, string[]>();
  for (const f of files) byTop.set(topOf(f.path), [...(byTop.get(topOf(f.path)) ?? []), f.path]);
  return [...byTop.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([top, paths]) => {
      const what = paths.length === 1 ? code(paths[0] as string) : `${plural(paths.length, "file")} under ${code(top === "." ? "the repo root" : `${top}/`)}`;
      return `| | ${cell(what)} | ignored by policy |${why ? " |" : ""} | 0 |`;
    });
}

type Subset = Extract<Selection, { kind: "subset" }>;

/** The pieces of a subset comment, so the brief can interleave its own sections. */
interface SubsetParts {
  header: string;
  lead: string;
  /** Rows of the summary table, without the title row. */
  summaryRows: string[];
  summaryTitle: string;
  figure: string;
  perFile: string;
  prefixNote: string;
  tests: string;
  blast: string;
}

/**
 * The status per changed file from cgraph's symbol changes: `parse` changed,
 * `helper` removed. Cheaper for the reader than the head-side symbol list
 * alone, because it says what happened to each symbol, not just where.
 */
function changeCell(path: string, symbols: SymbolChange[], fallback: string[]): string {
  const own = symbols.filter((s) => s.path === path);
  if (own.length === 0) return symbolsCell(fallback);
  const word = (status: string): string =>
    status === "changed" ? "changed" : status === "moved" ? "moved" : status.startsWith("added") ? "added" : status.startsWith("deleted") ? "removed" : status;
  const shown = own.slice(0, 3).map((s) => `${code(s.label)} ${word(s.status)}`);
  return own.length > 3 ? `${shown.join(", ")}, +${own.length - 3}` : shown.join(", ");
}

/** The per-file Why cell: the distinct reasons behind that file's changed symbols, at most two, each with its turn. */
function whyCell(path: string, reasons: SymbolReason[]): string {
  const own = reasons.filter((r) => r.path === path && r.why !== "");
  const seen = new Map<string, number>();
  for (const r of own) if (!seen.has(r.why)) seen.set(r.why, r.turn);
  const shown = [...seen.entries()].slice(0, 2).map(([why, turn]) => `turn ${turn}: ${cell(why.length > 100 ? `${why.slice(0, 99)}…` : why)}`);
  return seen.size > 2 ? `${shown.join("; ")}; +${seen.size - 2}` : shown.join("; ");
}

function subsetParts(selection: Subset, ctx: CommentContext, symbols?: SymbolChange[], reasons: SymbolReason[] = []): SubsetParts {
  const links = new Links(ctx);
  const mapped = selection.files.filter((f) => f.disposition === "mapped");
  const ignored = selection.files.filter((f) => f.disposition === "ignored");
  const symbolTotal = mapped.reduce((n, f) => n + f.symbols.length, 0);
  const reachedFiles = new Set<string>();
  for (const f of mapped) for (const r of f.reaches) reachedFiles.add(r.file);
  const n = selection.tests.length;
  const header = `${n} of ${plural(selection.testsTotal, "test file")} reach${n === 1 ? "es" : ""} this diff`;
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
  const summaryRows = [
    `| Changed | ${changedCell} |`,
    `| Tests reached | **${n}** of ${selection.testsTotal} ${bar(n, selection.testsTotal)} ${percent(n, selection.testsTotal)} of the suite |`,
    `| Downstream code | ${plural(reachedFiles.size, "file")}, ${plural(selection.blast.length, "dependent")} · review effort ${reviewEffort(selection.blast.length, mapped.length)} |`,
  ];

  const figure =
    ctx.figure === undefined
      ? ""
      : ctx.figure.kind === "image"
        ? `<picture><source media="(prefers-color-scheme: dark)" srcset="${ctx.figure.dark}"><img alt="Reach graph: ${mapped.length} changed files reach ${reachedFiles.size} files and ${n} of ${selection.testsTotal} tests" src="${ctx.figure.light}" width="940"></picture>`
        : [
            "```mermaid",
            ctx.figure.source,
            "```",
            "",
            "<sub>Changed files are double-bordered, tests are rounded; an arrow points from a file to what depends on it.</sub>",
          ].join("\n");

  const prefix = sharedDir(mapped.map((f) => f.path));
  const short = (rel: string): string => (prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
  let position = 0;
  const why = reasons.length > 0;
  const perFile = [
    `| Read | Changed file | ${symbols ? "Change" : "Symbols touched"} |${why ? " Why |" : ""} Reaches | Tests |`,
    `|---|---|---|${why ? "---|" : ""}---:|---:|`,
    ...readingOrder(mapped, selection.edges, ctx.repo).map(({ file: f, after }) => {
      const read = after ? `with ${code(short(after.path))}` : String(++position);
      const name = links.path(f.path, short(f.path)) + (f.status === "added" ? " (new)" : f.status === "deleted" ? " (deleted)" : "");
      const what = isTestFile(f) ? "test code, selected directly" : symbols ? changeCell(f.path, symbols, f.symbols) : symbolsCell(f.symbols);
      const reaches = f.reaches.length === 0 ? "" : plural(f.reaches.length, "file");
      return `| ${read} | ${cell(name)} | ${cell(what)} |${why ? ` ${whyCell(f.path, reasons)} |` : ""} ${reaches} | ${f.tests.length} |`;
    }),
    ...ignoredRows(ignored, why),
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

  return { header, lead, summaryRows, summaryTitle, figure, perFile, prefixNote, tests, blast };
}

function renderSubset(selection: Subset, ctx: CommentContext): string {
  const p = subsetParts(selection, ctx);
  const n = selection.tests.length;
  const summary = [`| Summary | ${p.summaryTitle} |`, "|---|---|", ...p.summaryRows, ctx.baseSha ? `| Compared against | base ${code(shortSha(ctx.baseSha))} |` : ""]
    .filter(Boolean)
    .join("\n");
  return [
    COMMENT_MARKER,
    `### Test impact: ${p.header}`,
    "",
    p.lead,
    "",
    summary,
    "",
    p.figure,
    p.figure ? "" : undefined,
    "#### What each changed file reaches",
    "",
    p.perFile,
    "",
    p.prefixNote,
    p.prefixNote ? "" : undefined,
    `#### Tests to run (${n})`,
    "",
    p.tests,
    "",
    p.blast,
    "",
    footer(selection.contentRoot, ctx),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function footer(contentRoot: string | undefined, ctx: CommentContext, extra: string[] = [], readme = README): string {
  const graph = contentRoot ? ` Graph ${code(contentRoot.slice(0, 7))}.` : "";
  const more = extra.length > 0 ? ` ${extra.join(" ")}` : "";
  return `<sub>blastline ${ctx.version}. Selection is advisory unless your workflow gates on it. [How selection works](${readme}).${graph}${more}</sub>`;
}

/** Each fail-open reason, as the cause and the one thing the reader can do about it. */
function explain(r: Exclude<FailOpenReason, { kind: "unmapped-file" }>, ctx: CommentContext): [why: string, action: string] {
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
      return [
        r.detail.split(ctx.repo.endsWith("/") ? ctx.repo : `${ctx.repo}/`).join(""),
        "Build the graph with `graph-root`, or point `graph-path` at an existing graph.json.",
      ];
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

type All = Extract<Selection, { kind: "all" }>;

/** The body of a fail-open comment, after its heading: the warning, the reasons, the unmapped files. */
function allBody(selection: All, ctx: CommentContext): string[] {
  const links = new Links(ctx);
  const unmapped = selection.reasons.filter((r) => r.kind === "unmapped-file").map((r) => r.path);
  const others = selection.reasons.filter(
    (r): r is Exclude<FailOpenReason, { kind: "unmapped-file" }> => r.kind !== "unmapped-file",
  );
  const at = links.compare();
  const where = at ? `Computed at ${at}${ctx.baseSha ? ` against base ${code(shortSha(ctx.baseSha))}` : ""}.` : `Range ${code(ctx.range)}.`;
  const table =
    others.length > 0
      ? [
          "| Why | What you can do |",
          "|---|---|",
          ...others.map((r) => `| ${explain(r, ctx).map(cell).join(" | ")} |`),
        ].join("\n")
      : "";
  return [
    "> [!WARNING]",
    "> **Run the full suite.** The graph cannot vouch for this diff, so every test file is selected. Nothing is skipped; this is the safe default, not a failure.",
    "",
    table,
    table ? "" : undefined,
    unmapped.length > 0 ? renderUnmapped(unmapped) : undefined,
    unmapped.length > 0 ? "" : undefined,
    where,
  ].filter((line): line is string => line !== undefined);
}

function renderAll(selection: All, ctx: CommentContext): string {
  return [COMMENT_MARKER, "### Test impact: run the full suite", "", ...allBody(selection, ctx), "", footer(undefined, ctx), ""].join("\n");
}

/** Render a selection as the PR-comment markdown the GitHub Action posts. */
export function renderComment(selection: Selection, ctx: CommentContext): string {
  return selection.kind === "all" ? renderAll(selection, ctx) : renderSubset(selection, ctx);
}

/** The test runners a list of commands invoked, with how often: `vitest (3), bun test (1)`. A command's text is never shown; it carries machine paths. */
function runnersOf(commands: string[]): string {
  const counts = new Map<string, number>();
  for (const command of commands) {
    const runner = TEST_RUNNER.exec(command)![1]!;
    counts.set(runner, (counts.get(runner) ?? 0) + 1);
  }
  return [...counts.entries()].map(([runner, n]) => `${code(runner)} (${n})`).join(", ");
}

/**
 * The Intent cell of a checkpointed commit: what the agent said in the
 * transcript window that ends at the checkpoint (its first line, then its
 * last when that differs), or the human's prompt when it said nothing; a
 * commit produced by the same step as an earlier one says so; then the agent
 * and model.
 */
function intentCell(cp: Checkpoint, links: Links): string {
  // A cut inside a code span would leave a backtick to pair with one in the next line and swallow the markup between.
  const truncate = (s: string, n: number): string => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n - 1);
    return `${cut}${(cut.match(/`/g)?.length ?? 0) % 2 === 1 ? "`" : ""}…`;
  };
  const who = cp.model ? ` <sub>${cp.agent ? `${cp.agent} · ` : ""}${cp.model}</sub>` : "";
  if (cp.sameStepAs !== undefined) return `_same step as ${links.commit(cp.sameStepAs)}_${who}`;
  const n = cp.narration;
  if (n.started === "") {
    if (cp.prompt !== "") return `${cell(truncate(cp.prompt, 120))}${who}`;
    return `_no narration${n.tools > 0 ? `, ${plural(n.tools, "tool call")}` : ""}_${who}`;
  }
  const then = n.ended === "" ? "" : `<br><sub>then: ${cell(truncate(n.ended, 120))}</sub>`;
  return `${cell(truncate(n.started, 120))}${then}${who}`;
}

/** The commit table: what each commit intended (its checkpoint), touched, reaches, and ran before the push. */
function commitTable(commits: CommitBrief[], links: Links): string {
  const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const rows = commits.map((c) => {
    const cp = c.checkpoint;
    const intent = cp
      ? intentCell(cp, links)
      : c.checkpointId !== undefined
        ? `_checkpoint ${code(c.checkpointId)} not fetched_`
        : c.provenance
          ? `_${c.provenance.agent} by ${c.provenance.via}_${c.provenance.logsUrl ? ` · [session log](${c.provenance.logsUrl})` : ""}`
          : "_no checkpoint_";
    const files = c.files.length === 0 ? "" : plural(c.files.length, "file");
    const reach = c.reach.files === 0 && c.reach.tests === 0 ? "" : `${plural(c.reach.files, "file")}, ${plural(c.reach.tests, "test")}`;
    const ran = !cp
      ? ""
      : cp.testCommands.length === 0
        ? "no test runner"
        : c.reachingTests.length === 0
          ? runnersOf(cp.testCommands)
          : `${c.ranReachingTests.length} of ${plural(c.reachingTests.length, "reaching test")}`;
    return `| ${links.commit(c.sha)} ${cell(truncate(c.subject, 60))} | ${intent} | ${files} | ${reach} | ${ran} |`;
  });
  const table = ["| Commit | Intent | Files | Reaches | Ran before push |", "|---|---|---:|---|---|", ...rows].join("\n");
  if (commits.length <= COMMIT_ROWS_UNFOLDED) return table;
  return [`<details><summary>${plural(commits.length, "commit")}</summary>`, "", table, "", "</details>"].join("\n");
}

function claimsList(claims: ClaimCheck[]): string {
  if (claims.length === 0) return "_no checkpoint on this branch makes a claim the graph can check_";
  const order: ClaimCheck["verdict"][] = ["refuted", "partial", "consistent"];
  return [...claims]
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict))
    .map((c) => `- **${c.verdict}**: ${c.claim}. ${c.evidence}.`)
    .join("\n");
}

function intentRow(brief: Brief): string {
  const withCheckpoint = brief.commits.filter((c) => c.checkpoint).length;
  const unfetched = brief.commits.filter((c) => c.checkpointId !== undefined && !c.checkpoint).length;
  const attributed = brief.commits.filter((c) => c.provenance).map((c) => c.provenance!.agent);
  const models = [...new Set(brief.commits.map((c) => c.checkpoint?.model).filter((m): m is string => !!m))];
  const total = plural(brief.commits.length, "commit");
  if (brief.commits.length === 0) return `| Intent | no commits in ${code(brief.range)} |`;
  if (withCheckpoint === 0 && unfetched === 0 && attributed.length === 0) {
    return `| Intent | no checkpoints on this branch (${total}): no ${code("Entire-Checkpoint")} or ${code("Agent-Logs-Url")} trailer, no vendor address |`;
  }
  const carry = brief.commits.length === 1 ? "carries" : "carry";
  const byTrailer = attributed.length === 0 ? "" : `${attributed.length} attributed by trailer (${[...new Set(attributed)].join(", ")})`;
  const none = brief.commits.filter((c) => c.checkpointId === undefined && !c.checkpoint && !c.provenance).length;
  const parts =
    withCheckpoint > 0
      ? [`${withCheckpoint} of ${total} ${carry} a checkpoint`, models.length > 0 ? models.map(code).join(", ") : "", byTrailer]
      : [`${attributed.length > 0 ? `${attributed.length} of ${total} attributed by trailer (${[...new Set(attributed)].join(", ")})` : `0 of ${total} ${carry} a checkpoint`}`];
  parts.push(unfetched > 0 ? `${unfetched} not fetched` : "", none > 0 && (withCheckpoint > 0 || attributed.length > 0) ? `${none} unattributed` : "");
  return `| Intent | ${parts.filter(Boolean).join(" · ")} |`;
}

/**
 * Who has looked, and who knows the reached code. "No reviewer other than the
 * author" is the exact fact; it never says "unreviewed", since whether the
 * author's own reading counts is the reader's call.
 */
function reviewedRow(brief: Brief): string | undefined {
  const r = brief.review;
  if (!r) return undefined;
  // Reviews never fetched is not "none": the row says nothing about who has looked and the footer says why.
  const others = r.reviews?.filter((v) => v.state !== "PENDING");
  const looked =
    others === undefined
      ? undefined
      : others.length > 0
        ? others.map((v) => `${v.login} (${v.state.toLowerCase().replace("_", " ")})`).join(", ")
        : r.author !== undefined
          ? `no reviewer other than the author (${r.author}) so far`
          : "no review so far";
  const top = r.owners.authors.slice(0, 3).map((a) => `${a.name} (${plural(a.commits, "commit")} in ${plural(a.files, "file")})`);
  const knows =
    r.owners.files === 0
      ? undefined
      : top.length === 0
        ? `no human commit in the ${plural(r.owners.files, "changed or reached file")} before this range${r.owners.agentCommits > 0 ? ` (${plural(r.owners.agentCommits, "agent commit")} set aside)` : ""}`
        : `the ${plural(r.owners.files, "changed and reached file")} were last changed by ${top.join(", ")}${r.owners.authors.length > 3 ? `, +${r.owners.authors.length - 3}` : ""}`;
  // When no human commit precedes the range at all, `knows` already says so; the gap would repeat it.
  const gap =
    r.unfamiliar === undefined || top.length === 0
      ? undefined
      : `${r.unfamiliar.names.join(", ")} ${r.unfamiliar.names.length === 1 ? "has" : "have"} no prior commit in ${r.unfamiliar.files.length} of the ${plural(r.unfamiliar.of, "file")} this change touches or reaches: ${r.unfamiliar.files.slice(0, 3).map(code).join(", ")}${r.unfamiliar.files.length > 3 ? `, +${r.unfamiliar.files.length - 3}` : ""}`;
  const parts = [looked, knows, gap].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : `| Reviewed by | ${parts.join(" · ")} |`;
}

/** Open PRs whose brief meets this one, each with the meeting point that matters most first. */
function concurrentRow(brief: Brief): string | undefined {
  const prs = brief.concurrent;
  if (!prs || prs.length === 0) return undefined;
  const files = (paths: string[]): string => `${paths.slice(0, 2).map(code).join(", ")}${paths.length > 2 ? `, +${paths.length - 2}` : ""}`;
  const parts = prs.slice(0, 3).map((p) => {
    const bits: string[] = [];
    if (p.changesReached.length > 0) {
      const entries = p.changesReached
        .slice(0, 2)
        .map((c) => (c.symbols.length > 0 ? `${c.symbols.slice(0, 2).map(code).join(", ")}${c.symbols.length > 2 ? `, +${c.symbols.length - 2}` : ""} (${code(c.path)})` : code(c.path)));
      const more = p.changesReached.length > 2 ? `, +${plural(p.changesReached.length - 2, "file")}` : "";
      bits.push(`changes ${entries.join(", ")}${more}, which this PR reaches`);
    }
    if (p.bothChange.length > 0) bits.push(`also changes ${files(p.bothChange)}`);
    if (p.reachesChanged.length > 0) bits.push(`reaches ${files(p.reachesChanged)}, which this PR changes`);
    return `#${p.number} ${bits.join("; ")}`;
  });
  return `| Concurrent PRs | ${parts.join(" · ")}${prs.length > 3 ? `, +${prs.length - 3}` : ""} |`;
}

function symbolsRow(brief: Brief): string | undefined {
  const cc = brief.changeContext;
  if (!cc) return undefined;
  const count = (test: (s: string) => boolean): number => cc.symbols.filter((s) => test(s.status)).length;
  const parts = [
    [count((s) => s === "changed"), "changed"],
    [count((s) => s.startsWith("added")), "added"],
    [count((s) => s.startsWith("deleted")), "removed"],
    [count((s) => s === "moved"), "moved"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}`);
  return `| Symbols | ${parts.length > 0 ? parts.join(", ") : "none classified"} within the diff |`;
}

function sinceRow(brief: Brief): string | undefined {
  const d = brief.sincePrevious;
  if (!d) return undefined;
  const signed = (n: number, one: string, many: string): string => `${n > 0 ? "+" : ""}${n} ${Math.abs(n) === 1 ? one : many}`;
  const parts = [plural(d.commits, "new commit"), signed(d.files, "changed file", "changed files"), signed(d.tests, "test reached", "tests reached")];
  if (d.newlyReached.length > 0) parts.push(`newly reaches ${d.newlyReached.slice(0, 3).map(code).join(", ")}${d.newlyReached.length > 3 ? `, +${d.newlyReached.length - 3}` : ""}`);
  return `| Since push ${code(shortSha(d.head))} | ${parts.join(", ")} |`;
}

/** What the brief could not classify or check, and the change-context counters, verbatim. */
function briefFooter(brief: Brief, ctx: CommentContext): string {
  const extra: string[] = [];
  const cc = brief.changeContext;
  if (cc) extra.push(`change-context budget ${cc.budget}: omitted ${cc.omitted.impacts} impacts, ${cc.omitted.context} context entries${cc.truncated ? " (truncated)" : ""}; symbols are classified within the diff only.`);
  const withCheckpoint = brief.commits.filter((c) => c.checkpoint).length;
  const byTrailer = brief.commits.filter((c) => c.provenance).length;
  extra.push(`Intent: ${withCheckpoint} of ${plural(brief.commits.length, "commit")}${byTrailer > 0 ? `, ${byTrailer} attributed by trailer` : ""}.`);
  for (const u of brief.unchecked) extra.push(`Not checked: ${u}.`);
  const contentRoot = brief.selection.kind === "subset" ? brief.selection.contentRoot : undefined;
  return footer(contentRoot, ctx, extra, BRIEF_README);
}

/**
 * The PR brief: the test-impact comment grown a per-commit table, a claims
 * list, an intent and a symbols row, and the delta since the previous push.
 * Same marker as `renderComment`, so an existing comment is edited in place.
 */
export function renderBrief(brief: Brief, ctx: CommentContext): string {
  const links = new Links(ctx);
  const agentCommits = brief.commits.filter((c) => c.checkpoint || c.provenance).length;
  const title = `### PR brief: ${plural(agentCommits, "agent commit")} · `;
  const snapshot = `${SNAPSHOT_MARKER}${JSON.stringify(brief.snapshot)} -->`;
  const sections = (verdictParts: (string | undefined)[]): (string | undefined)[] => [
    "#### What each commit did",
    "",
    commitTable(brief.commits, links),
    "",
    "#### Claims checked",
    "",
    claimsList(brief.claims),
    "",
    ...verdictParts,
  ];
  if (brief.selection.kind === "all") {
    return [
      COMMENT_MARKER,
      snapshot,
      `${title}run the full suite`,
      "",
      ...allBody(brief.selection, ctx),
      "",
      `| Summary | ${ctx.prNumber !== undefined ? `PR #${ctx.prNumber}` : code(ctx.range)} |`,
      "|---|---|",
      intentRow(brief),
      reviewedRow(brief),
      concurrentRow(brief),
      symbolsRow(brief),
      sinceRow(brief),
      "",
      ...sections([]),
      briefFooter(brief, ctx),
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  const p = subsetParts(brief.selection, ctx, brief.changeContext?.symbols, brief.commits.flatMap((c) => c.checkpoint?.reasons ?? []));
  const n = brief.selection.tests.length;
  const summary = [
    `| Summary | ${p.summaryTitle} |`,
    "|---|---|",
    ...p.summaryRows,
    intentRow(brief),
    reviewedRow(brief),
    concurrentRow(brief),
    symbolsRow(brief),
    sinceRow(brief),
    ctx.baseSha ? `| Compared against | base ${code(shortSha(ctx.baseSha))} |` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return [
    COMMENT_MARKER,
    snapshot,
    `${title}${p.header}`,
    "",
    p.lead,
    "",
    summary,
    "",
    p.figure,
    p.figure ? "" : undefined,
    ...sections([
      "#### What each changed file reaches",
      "",
      p.perFile,
      "",
      p.prefixNote,
      p.prefixNote ? "" : undefined,
      `#### Tests to run (${n})`,
      "",
      p.tests,
      "",
      p.blast,
      "",
    ]),
    briefFooter(brief, ctx),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** The Checks API `check-runs` request body for a brief: one run per head sha, annotations on the highest-reach lines. */
export interface CheckRun {
  name: "blastline";
  head_sha: string;
  status: "completed";
  conclusion: "neutral";
  output: { title: string; summary: string; text: string; annotations: Brief["annotations"] };
}

export function renderCheckRun(brief: Brief, markdown: string, headSha: string): CheckRun {
  const lines = markdown.split("\n");
  const heading = lines.find((l) => l.startsWith("### ")) ?? "### PR brief";
  const body = lines.filter((l) => !l.startsWith("<!-- ")).join("\n");
  const summaryEnd = body.indexOf("\n#### ");
  return {
    name: "blastline",
    head_sha: headSha,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: heading.replace(/^### /, "").slice(0, 255),
      summary: (summaryEnd === -1 ? body : body.slice(0, summaryEnd)).slice(0, 65535),
      text: (summaryEnd === -1 ? "" : body.slice(summaryEnd + 1)).slice(0, 65535),
      annotations: brief.annotations,
    },
  };
}
