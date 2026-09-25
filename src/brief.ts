import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCallers } from "./check.js";
import type { Checkpoint, Provenance } from "./checkpoint.js";
import { checkpointFor, checkpointRef, checkpointTrailer, provenanceOf } from "./checkpoint.js";
import type { Owners } from "./owners.js";
import { ownersOf } from "./owners.js";
import { SessionsIndex, localCheckpoint } from "./sessions.js";
import { parseUnifiedDiff } from "./diff.js";
import type { CodeGraph } from "./graph.js";
import { loadGraph } from "./graph.js";
import { relativeTo } from "./paths.js";
import type { RunOptions } from "./run.js";
import { runSelection } from "./run.js";
import type { ChangedFileImpact, Selection } from "./types.js";

/** One symbol-level change from `cgraph change-context`, `changes[].symbol_changes[]`. */
export interface SymbolChange {
  /** Head path of the file (`new_path`), or the base path when the file is gone. */
  path: string;
  label: string;
  kind: string;
  /** cgraph's word, verbatim: `changed`, `moved`, `added_or_renamed`, `deleted_or_renamed`. */
  status: string;
  /** Line at head; at base when the symbol no longer exists at head. */
  line: number;
}

/** What the brief keeps of a `cgraph change-context` result. The counters are verbatim. */
export interface ChangeContext {
  symbols: SymbolChange[];
  budget: number;
  omitted: { impacts: number; context: number };
  truncated: boolean;
}

export interface CommitBrief {
  sha: string;
  subject: string;
  /** The id from the commit's trailer, present even when the ref itself is missing. */
  checkpointId?: string;
  checkpoint?: Checkpoint;
  /** Who made the commit, from its own marks, when it carries no checkpoint trailer at all. */
  provenance?: Provenance;
  /** Repo-relative paths the commit touched. */
  files: string[];
  /** Reach of this commit's files, from the whole-range selection; zero when it failed open. */
  reach: { files: number; tests: number };
  /** Repo-relative test files reached from this commit's files. */
  reachingTests: string[];
  /** The subset of `reachingTests` a test command in the checkpoint ran. */
  ranReachingTests: string[];
}

/**
 * A claim the agent's checkpoint makes, checked against the graph and the diff.
 * `refuted` is authoritative; `consistent` is not a certificate, which is why
 * the word "verified" never appears.
 */
export interface ClaimCheck {
  claim: string;
  verdict: "refuted" | "partial" | "consistent";
  evidence: string;
}

/** A Checks API annotation on a changed range, carrying that range's reach. */
export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice";
  title: string;
  message: string;
}

/**
 * What a brief remembers about itself so the next push can say what changed.
 * Embedded in the rendered comment; parsed back by `--previous`.
 */
export interface BriefSnapshot {
  head: string;
  commits: number;
  files: number;
  tests: number;
  /** Repo-relative downstream files the diff reached. */
  reached: string[];
}

export interface SincePrevious {
  head: string;
  commits: number;
  files: number;
  tests: number;
  newlyReached: string[];
}

/** A review the PR has received, as GitHub's reviews API lists it. */
export interface Review {
  login: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string;
}

/**
 * Who has looked at the change, and who knows the code it reaches: the PR's
 * reviews other than the author's, and the humans whose commits last touched
 * the changed and reached files before this range.
 */
export interface ReviewState {
  /** The PR author: the human who opened it, or invoked the agent that did. */
  author?: string;
  /** Reviews by anyone but the author, latest state per login. */
  reviews: Review[];
  owners: Owners;
}

export interface Brief {
  range: string;
  baseSha?: string;
  headSha?: string;
  selection: Selection;
  changeContext?: ChangeContext;
  commits: CommitBrief[];
  claims: ClaimCheck[];
  /** Present when the range resolved: owners are read from the base's history. */
  review?: ReviewState;
  sincePrevious?: SincePrevious;
  annotations: Annotation[];
  /** What this brief could not check, one line each, printed verbatim. */
  unchecked: string[];
  snapshot: BriefSnapshot;
}

export interface BriefOptions extends RunOptions {
  range: string;
  /** A selection already computed for this range (the Action's `--json` output), instead of running one. */
  selection?: Selection;
  /** The commit to call the head when the range ends elsewhere (a `pull_request` merge commit standing in for the PR head). */
  headSha?: string;
  /** `cgraph change-context` JSON. */
  changeContextFile?: string;
  /** The previously rendered comment, whose embedded snapshot gives the delta. */
  previousFile?: string;
  /** The PR author's login; with `reviews`, the Reviewed-by row says whether anyone else has looked. */
  author?: string;
  /** The PR's reviews (GitHub's reviews API: user.login and state), any order. */
  reviews?: Review[];
  /** Annotation count, at most 50 (the Checks API ceiling per request). Default 50. */
  annotations?: number;
  /**
   * On the agent machine: a commit without a checkpoint ref takes its intent
   * from the fleet session index (agents-cli's sessions.db) instead. The path
   * of that database; nothing is written and nothing leaves the machine.
   */
  sessionsDb?: string;
}

/** GitHub's reviews API body (`user.login`, `state`), or the brief's own `{login, state}` shape, to reviews. */
export function reviewsIn(json: string): Review[] {
  const rows = JSON.parse(json) as { login?: unknown; state?: unknown; user?: { login?: unknown } }[];
  if (!Array.isArray(rows)) throw new Error("reviews: expected a JSON array");
  return rows.flatMap((r) => {
    const login = typeof r.login === "string" ? r.login : typeof r.user?.login === "string" ? r.user.login : undefined;
    return login !== undefined && typeof r.state === "string" ? [{ login, state: r.state }] : [];
  });
}

export const MAX_ANNOTATIONS = 50;
export const SNAPSHOT_MARKER = "<!-- blastline:brief ";

/** Full shas of both ends of a range, or undefined when git cannot resolve them. */
export function resolveRange(repo: string, range: string): { base: string; head: string } | undefined {
  const cut = range.indexOf("..");
  if (cut === -1) return undefined;
  try {
    const rev = (ref: string): string =>
      execFileSync("git", ["-C", repo, "rev-parse", `${ref}^{commit}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return { base: rev(range.slice(0, cut)), head: rev(range.slice(cut + 2).replace(/^\./, "")) };
  } catch {
    return undefined;
  }
}

interface ChangeContextJson {
  budget?: number;
  truncated?: boolean;
  omitted?: { impacts?: number; context?: number };
  changes?: {
    new_path?: string;
    old_path?: string;
    symbol_changes?: {
      status?: string;
      base?: { label?: string; kind?: string; line?: number } | null;
      target?: { label?: string; kind?: string; line?: number } | null;
    }[];
  }[];
}

export function parseChangeContext(text: string): ChangeContext {
  const raw = JSON.parse(text) as ChangeContextJson;
  const symbols: SymbolChange[] = [];
  for (const change of raw.changes ?? []) {
    for (const s of change.symbol_changes ?? []) {
      const at = s.target ?? s.base;
      if (!at) continue;
      symbols.push({
        path: (s.target ? change.new_path : change.old_path) ?? change.new_path ?? change.old_path ?? "",
        label: at.label ?? "",
        kind: at.kind ?? "",
        status: s.status ?? "",
        line: at.line ?? 0,
      });
    }
  }
  return {
    symbols,
    budget: raw.budget ?? 0,
    omitted: { impacts: raw.omitted?.impacts ?? 0, context: raw.omitted?.context ?? 0 },
    truncated: raw.truncated ?? false,
  };
}

/** The snapshot a rendered brief embeds, or undefined when the text carries none. */
export function snapshotIn(text: string): BriefSnapshot | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith(SNAPSHOT_MARKER) || !line.endsWith(" -->")) continue;
    try {
      return JSON.parse(line.slice(SNAPSHOT_MARKER.length, -" -->".length)) as BriefSnapshot;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const RUNNER_WORDS = /^(npx|bunx|pnpm|yarn|npm|bun|node|python3?|go|cargo|mvn|gradlew?|run|test|exec)$/;

/**
 * Whether a test command ran a given repo-relative test file. A command that
 * names no path runs the whole suite; one that names paths runs the files it
 * names and everything under the directories it names.
 */
export function commandRuns(command: string, testPath: string): boolean {
  const paths = command
    .split(/\s+/)
    .filter((t) => t !== "" && !t.startsWith("-") && /[/.]/.test(t) && !/^\.\/?$|^\.\/\.\.\.$|^\d+>&\d+$/.test(t) && !RUNNER_WORDS.test(t))
    .map((t) => t.replace(/^\.\//, "").replace(/\/$/, ""));
  if (paths.length === 0) return true;
  return paths.some((p) => testPath === p || testPath.endsWith(`/${p}`) || testPath.startsWith(`${p}/`));
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listOf(items: string[], limit = 4): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, +${items.length - limit}` : shown;
}

/** The file node's label: relative to the graph root (bin-v0.5.0), which is the repository root only when the graph was built there. */
function fileLabel(graph: CodeGraph, abs: string): string {
  return graph.byFile.get(abs)?.find((n) => n.type === "file")?.label ?? abs;
}

/**
 * Where the graph root sits in the repository, as a path prefix ("src/", or
 * "" when the graph was built at the root): the part a diff path carries that
 * the same file's label lacks. Learned from any changed file the graph knows.
 */
function labelPrefix(graph: CodeGraph, changedPaths: Set<string>): string {
  for (const p of changedPaths) {
    for (const [abs, nodes] of graph.byFile) {
      const label = nodes.find((n) => n.type === "file")?.label;
      if (label === undefined || !abs.endsWith(`/${p}`) || !p.endsWith(label)) continue;
      return p.slice(0, p.length - label.length);
    }
  }
  return "";
}

/**
 * "Removed X" is refuted when the base graph shows a static caller in a file
 * this diff did not touch: that caller still names a symbol that no longer
 * exists. Callers inside changed files may have been updated, so they do not
 * refute; they are listed so the reviewer can check.
 */
function removedSymbolClaims(symbols: SymbolChange[], baseGraph: CodeGraph, changedPaths: Set<string>): ClaimCheck[] {
  const claims: ClaimCheck[] = [];
  const prefix = labelPrefix(baseGraph, changedPaths);
  for (const s of symbols) {
    if (!s.status.startsWith("deleted")) continue;
    const claim = `\`${s.label}\` removed from \`${s.path}\``;
    const result = checkCallers({ graph: baseGraph, symbol: `${s.path}:${s.label}` });
    if (result.kind === "fail-open") {
      const why = result.reasons[0]?.kind ?? "unknown";
      claims.push({ claim, verdict: "partial", evidence: `could not resolve it in the base graph (${why})` });
      continue;
    }
    const repoPath = (c: { file?: string }): string => (c.file ? prefix + fileLabel(baseGraph, c.file) : "");
    const describe = (c: { label: string; kind: string; file?: string; line?: number }): string => {
      const file = repoPath(c);
      const at = file ? ` (${file}${c.line !== undefined && c.kind !== "file" ? `:${c.line}` : ""})` : "";
      return c.kind === "file" ? `\`${file}\`` : `\`${c.label}\`${at}`;
    };
    const inChanged = (c: { file?: string }): boolean => changedPaths.has(repoPath(c));
    // Symbols before their files: `use (src/use.ts:3)` says more than `src/use.ts`.
    const callers = [...result.callers].sort((a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.label.localeCompare(b.label));
    const remaining = callers.filter((c) => !inChanged(c));
    const updated = callers.filter(inChanged);
    if (remaining.length > 0) {
      claims.push({
        claim,
        verdict: "refuted",
        evidence: `still referenced by ${listOf(remaining.map(describe))} in files this diff does not touch`,
      });
    } else if (updated.length > 0) {
      claims.push({
        claim,
        verdict: "consistent",
        evidence: `${plural(updated.length, "static caller")} in the base graph, all in files this diff changes: ${listOf(updated.map(describe))}`,
      });
    } else {
      claims.push({
        claim,
        verdict: "consistent",
        evidence: "no static callers in the base graph; dynamic dispatch, reflection and macros are invisible to it",
      });
    }
  }
  return claims;
}

function checkpointClaims(commit: CommitBrief): ClaimCheck[] {
  const cp = commit.checkpoint;
  if (!cp) return [];
  const claims: ClaimCheck[] = [];
  const sha = `\`${shortSha(commit.sha)}\``;
  if (commit.reachingTests.length > 0) {
    const ran = commit.ranReachingTests;
    const notRun = commit.reachingTests.filter((t) => !ran.includes(t));
    const claim = `${sha} ran the tests it reaches`;
    if (cp.testCommands.length === 0) {
      claims.push({ claim, verdict: "refuted", evidence: `no test runner in the checkpoint; reaching: ${listOf(commit.reachingTests)}` });
    } else if (notRun.length === 0) {
      claims.push({ claim, verdict: "consistent", evidence: `ran all ${commit.reachingTests.length}: ${listOf(ran)}` });
    } else {
      claims.push({
        claim,
        verdict: ran.length === 0 ? "refuted" : "partial",
        evidence: `ran ${ran.length} of ${commit.reachingTests.length}${ran.length > 0 ? `: ${listOf(ran)}` : ""}; not run: ${listOf(notRun)}`,
      });
    }
  }
  if (cp.filesTouched.length > 0) {
    const extra = cp.filesTouched.filter((f) => !commit.files.includes(f));
    const claim = `${sha} commits what the agent touched`;
    claims.push(
      extra.length > 0
        ? { claim, verdict: "refuted", evidence: `touched but not in the commit: ${listOf(extra)}` }
        : { claim, verdict: "consistent", evidence: `all ${plural(cp.filesTouched.length, "touched file")} are in the commit` },
    );
  }
  return claims;
}

/**
 * One brief for a range: the selection (reach), symbol changes from
 * change-context, one row per commit with its checkpoint, the claims those
 * checkpoints make checked against the graph, the delta since the previous
 * brief, and annotations on the highest-reach changed lines. Never throws for
 * a missing graph or checkpoint: those become fail-open reasons and empty rows.
 */
export function buildBrief(o: BriefOptions): Brief {
  const repo = resolve(o.repo);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

  const { range, selection: given, headSha: headOverride, changeContextFile, previousFile, annotations: annotationLimit, author, reviews, ...runOptions } = o;
  const selection = given ?? runSelection({ ...runOptions, range });
  const resolved = resolveRange(repo, range);
  const shas = resolved && headOverride !== undefined ? { base: resolved.base, head: headOverride } : resolved;
  const unchecked: string[] = [];

  let diffText = "";
  try {
    diffText = git("diff", "--unified=0", range);
  } catch {
    unchecked.push(`git could not diff \`${range}\``);
  }
  const parsed = parseUnifiedDiff(diffText);
  const changedPaths = new Set<string>();
  for (const f of parsed) {
    changedPaths.add(f.path);
    changedPaths.add(f.oldPath);
  }

  let changeContext: ChangeContext | undefined;
  if (changeContextFile !== undefined) {
    try {
      changeContext = parseChangeContext(readFileSync(changeContextFile, "utf8"));
    } catch (e) {
      unchecked.push(`symbol changes: cannot read change-context at ${changeContextFile}: ${(e as Error).message}`);
    }
  } else {
    unchecked.push("symbol changes: no `--change-context` given");
  }

  let shaList: string[] = [];
  try {
    shaList = git("rev-list", "--no-merges", "--reverse", range).split("\n").filter(Boolean);
  } catch {
    unchecked.push(`commits: git could not list \`${range}\``);
  }
  const byPath = new Map<string, ChangedFileImpact>(selection.kind === "subset" ? selection.files.map((f) => [f.path, f]) : []);
  const sessions = o.sessionsDb === undefined ? undefined : new SessionsIndex(o.sessionsDb);
  let commits: CommitBrief[];
  try {
    commits = shaList.map((sha) => {
      const subject = git("log", "-1", "--format=%s", sha).trim();
      const files = git("diff-tree", "--no-commit-id", "--name-only", "-r", "-m", sha).split("\n").filter(Boolean);
      const checkpointId = checkpointTrailer(repo, sha);
      const checkpoint =
        checkpointId !== undefined ? checkpointFor(repo, sha) : sessions === undefined ? undefined : localCheckpoint(sessions, repo, sha, files);
      // Only for a commit with no trailer at all: a dangling trailer stays "not fetched", which names the fix (push the refs).
      const provenance = checkpointId === undefined && checkpoint === undefined ? provenanceOf(repo, sha) : undefined;
      if (checkpointId !== undefined && checkpoint === undefined) {
        const present = (() => {
          try {
            git("rev-parse", "--verify", "--quiet", `${checkpointRef(checkpointId)}^{commit}`);
            return true;
          } catch {
            return false;
          }
        })();
        unchecked.push(
          present
            ? `checkpoint \`${checkpointId}\` for \`${shortSha(sha)}\`: its ref is present but not in Entire's layout, so it was not read`
            : `checkpoint \`${checkpointId}\` for \`${shortSha(sha)}\`: its ref is not in this repository (push refs/entire/checkpoints/*)`,
        );
      }
      const impacts = files.map((f) => byPath.get(f)).filter((f): f is ChangedFileImpact => f !== undefined && f.disposition === "mapped");
      const reached = new Set<string>();
      const tests = new Set<string>();
      for (const f of impacts) {
        for (const r of f.reaches) reached.add(r.file);
        for (const t of f.tests) tests.add(t);
      }
      const reachingTests = [...tests].sort().map((t) => relativeTo(repo, t));
      const ranReachingTests = checkpoint ? reachingTests.filter((t) => checkpoint.testCommands.some((c) => commandRuns(c, t))) : [];
      return {
        sha,
        subject,
        ...(checkpointId !== undefined && { checkpointId }),
        ...(checkpoint !== undefined && { checkpoint }),
        ...(provenance !== undefined && { provenance }),
        files,
        reach: { files: reached.size, tests: reachingTests.length },
        reachingTests,
        ranReachingTests,
      };
    });
  } finally {
    sessions?.close();
  }
  const unattributed = commits.filter((c) => c.checkpointId === undefined && c.checkpoint === undefined && c.provenance === undefined).length;
  if (unattributed > 0) {
    unchecked.push(
      `intent for ${plural(unattributed, "commit")}: no \`Entire-Checkpoint\` or \`Agent-Logs-Url\` trailer, no vendor address as author or co-author${sessions === undefined ? ", and no session index (\`--local\`) on this machine" : ", and no session was working here at commit time"}`,
    );
  }

  const claims: ClaimCheck[] = [];
  if (changeContext !== undefined && changeContext.symbols.some((s) => s.status.startsWith("deleted"))) {
    if (o.baseGraphPath === undefined) {
      unchecked.push("removed-symbol callers: no `--base-graph` given");
    } else {
      try {
        claims.push(...removedSymbolClaims(changeContext.symbols, loadGraph(o.baseGraphPath), changedPaths));
      } catch (e) {
        unchecked.push(`removed-symbol callers: cannot load base graph at ${o.baseGraphPath}: ${(e as Error).message}`);
      }
    }
  }
  for (const c of commits) claims.push(...checkpointClaims(c));

  const reachedFiles = new Set<string>();
  if (selection.kind === "subset") for (const f of selection.files) for (const r of f.reaches) reachedFiles.add(relativeTo(repo, r.file));

  let review: ReviewState | undefined;
  if (shas === undefined) {
    unchecked.push("reviewed by: the range did not resolve, so no history was read");
  } else {
    const mapped = selection.kind === "subset" ? selection.files.filter((f) => f.disposition === "mapped").map((f) => f.path) : [...changedPaths];
    const latest = new Map<string, string>();
    for (const r of reviews ?? []) if (r.login !== author) latest.set(r.login, r.state);
    review = {
      ...(author !== undefined && { author }),
      reviews: [...latest.entries()].map(([login, state]) => ({ login, state })),
      owners: ownersOf(repo, shas.base, [...new Set([...mapped, ...reachedFiles])].sort()),
    };
    if (reviews === undefined) unchecked.push("reviewed by: no `--reviews` given, so the row names owners only");
  }
  const snapshot: BriefSnapshot = {
    head: shas?.head ?? range,
    commits: commits.length,
    files: selection.kind === "subset" ? selection.files.length : 0,
    tests: selection.kind === "subset" ? selection.tests.length : 0,
    reached: [...reachedFiles].sort(),
  };

  let sincePrevious: SincePrevious | undefined;
  if (previousFile !== undefined) {
    let previous: BriefSnapshot | undefined;
    try {
      previous = snapshotIn(readFileSync(previousFile, "utf8"));
      if (previous === undefined) unchecked.push(`delta since the previous brief: ${previousFile} carries no \`${SNAPSHOT_MARKER.trim()}\` line`);
    } catch (e) {
      unchecked.push(`delta since the previous brief: cannot read ${previousFile}: ${(e as Error).message}`);
    }
    if (previous !== undefined) {
      let newCommits: number;
      try {
        newCommits = Number(git("rev-list", "--count", "--no-merges", `${previous.head}..${snapshot.head}`).trim());
      } catch {
        // The previous head is gone (a rebase or force-push): count what we can.
        newCommits = snapshot.commits - previous.commits;
      }
      sincePrevious = {
        head: previous.head,
        commits: newCommits,
        files: snapshot.files - previous.files,
        tests: snapshot.tests - previous.tests,
        newlyReached: snapshot.reached.filter((r) => !previous.reached.includes(r)),
      };
    }
  }

  const annotations: Annotation[] = [];
  if (selection.kind === "subset") {
    const candidates: (Annotation & { tests: number; reaches: number })[] = [];
    for (const file of parsed) {
      const impact = byPath.get(file.path);
      if (!impact || impact.disposition !== "mapped" || file.status === "deleted") continue;
      if (impact.reaches.length === 0 && impact.tests.length === 0) continue;
      const through = impact.symbols.length > 0 ? ` through ${listOf(impact.symbols, 3)}` : "";
      for (const r of file.ranges) {
        if (r.deletion) continue;
        candidates.push({
          path: file.path,
          start_line: r.start,
          end_line: r.end,
          annotation_level: "notice",
          title: "blastline: reach",
          message: `Reaches ${plural(impact.reaches.length, "file")} and ${plural(impact.tests.length, "test file")}${through}.`,
          tests: impact.tests.length,
          reaches: impact.reaches.length,
        });
      }
    }
    candidates.sort((a, b) => b.tests - a.tests || b.reaches - a.reaches || a.path.localeCompare(b.path) || a.start_line - b.start_line);
    const limit = Math.min(annotationLimit ?? MAX_ANNOTATIONS, MAX_ANNOTATIONS);
    for (const { tests: _t, reaches: _r, ...a } of candidates.slice(0, limit)) annotations.push(a);
  }

  return {
    range,
    ...(shas !== undefined && { baseSha: shas.base, headSha: shas.head }),
    selection,
    ...(changeContext !== undefined && { changeContext }),
    commits,
    claims,
    ...(review !== undefined && { review }),
    ...(sincePrevious !== undefined && { sincePrevious }),
    annotations,
    unchecked,
    snapshot,
  };
}
