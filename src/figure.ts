import { relativeTo, sharedDir } from "./paths.js";
import type { ChangedFileImpact, FileEdge, Selection } from "./types.js";

/**
 * The reach figure: what the diff touched, what that reaches, and which tests
 * sit at the end. File-level on purpose -- symbol-level graphs of a real PR
 * run to hundreds of nodes and explain nothing at comment width.
 *
 * One layout, two renderings. The SVG is the figure at its best: three fixed
 * columns in dependency order, a "+N more" fold per column, same-column
 * dependencies as dashed arcs. It needs hosting an image can be fetched from
 * anonymously, which a private repository cannot offer, so the same layout
 * also renders as a mermaid block GitHub draws itself: layers become node
 * shapes and colors, and the engine picks the positions.
 */

export type FigureTheme = "dark" | "light";

export interface FigureOptions {
  theme: FigureTheme;
  /** Absolute repo root; graph paths are shown relative to it. */
  repo: string;
  /** Rows per column before the remainder folds into a "+N more" node (default 12). */
  maxRows?: number;
  /** Caption line drawn bottom-right, e.g. "blastline 0.11.0 · PR #587 at 5fdb972". */
  caption?: string;
}

const PALETTE: Record<FigureTheme, Record<string, string>> = {
  dark: {
    bg: "#0d1117",
    panel: "#161b22",
    fg: "#e6edf3",
    muted: "#8b949e",
    changed: "#f5a651",
    reached: "#6ea8fe",
    test: "#59d499",
    edge: "#8b949e",
  },
  light: {
    bg: "#ffffff",
    panel: "#f6f8fa",
    fg: "#1f2328",
    muted: "#656d76",
    changed: "#b35900",
    reached: "#0969da",
    test: "#1a7f37",
    edge: "#8c959f",
  },
};

type Column = "changed" | "reached" | "test";
const COLUMNS: Column[] = ["changed", "reached", "test"];
const COLUMN_X: Record<Column, number> = { changed: 36, reached: 384, test: 682 };
const NODE_W: Record<Column, number> = { changed: 306, reached: 236, test: 240 };
const WIDTH = 940;
const NODE_H = 26;
const GAP = 10;
const TOP = 44;
const BOTTOM = 30;
const CHAR_W = 7.3; // ui-monospace at 12px, close enough to keep labels inside their box

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Keep the end of a path, which names the file, and elide the front to fit `chars` columns. */
function fit(label: string, chars: number): string {
  return label.length <= chars ? label : `…${label.slice(label.length - (chars - 1))}`;
}

function isTest(f: ChangedFileImpact): boolean {
  return f.tests.some((t) => t.endsWith(`/${f.path}`) || t === f.path);
}

interface Node {
  key: string;
  /** Repo-relative path with the shared prefix dropped; "+N more" for a fold. */
  label: string;
  note?: string;
  column: Column;
  /** Row within the column. */
  index: number;
  more: boolean;
}

interface Layout {
  nodes: Node[];
  /** Pairs of node keys, dependency first, folded onto "+N more" nodes and deduplicated. */
  edges: [from: string, to: string][];
  /** Directory every shown path shares, "" when none. */
  prefix: string;
  captions: Record<Column, string>;
}

/**
 * Pick the rows each column shows. Changed files come first in diff order;
 * reached and test files are ordered by how many changed files reach them, so
 * the fold keeps the most connected ones visible.
 */
function rows(files: ChangedFileImpact[], tests: string[], edges: FileEdge[], maxRows: number) {
  // An edited test file is drawn once, in the tests column, where it will run.
  const changed = files.filter((f) => f.disposition === "mapped" && !isTest(f)).map((f) => f.path);
  const reachCount = new Map<string, number>();
  for (const f of files) for (const r of f.reaches) reachCount.set(r.file, (reachCount.get(r.file) ?? 0) + 1);
  const reached = [...reachCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
  const inbound = new Map<string, number>();
  for (const e of edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  const testRows = [...tests].sort((a, b) => (inbound.get(b) ?? 0) - (inbound.get(a) ?? 0) || a.localeCompare(b));
  const cap = (list: string[]) => ({ shown: list.slice(0, maxRows), hidden: Math.max(0, list.length - maxRows) });
  return { changed: cap(changed), reached: cap(reached), test: cap(testRows) };
}

/** The shared layout, or null when there is nothing to draw: fail-open, or no mapped file outside the tests. */
export function layout(selection: Selection, repo: string, maxRows = 12): Layout | null {
  if (selection.kind !== "subset") return null;
  // Nothing mapped outside the tests themselves (every changed file ignored
  // by policy, or only test files edited) leaves no reach to draw: captions
  // over an empty box explain less than no figure.
  if (!selection.files.some((f) => f.disposition === "mapped" && !isTest(f))) return null;
  const { changed, reached, test } = rows(selection.files, selection.tests, selection.edges, maxRows);

  // Changed rows are repo-relative already; reached/test rows are absolute.
  const changedAbs = new Map<string, string>();
  for (const e of selection.edges) {
    for (const abs of [e.from, e.to]) {
      const rel = relativeTo(repo, abs);
      if (changed.shown.includes(rel)) changedAbs.set(rel, abs);
    }
  }
  const prefix = sharedDir([
    ...changed.shown,
    ...reached.shown.map((p) => relativeTo(repo, p)),
    ...test.shown.map((p) => relativeTo(repo, p)),
  ]);
  const shown = (key: string): string => {
    const rel = relativeTo(repo, key);
    return prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
  };

  const nodes = new Map<string, Node>();
  const place = (column: Column, keys: string[], hidden: number, note?: (key: string) => string | undefined) => {
    keys.forEach((key, index) => {
      if (nodes.has(key)) return; // a file drawn once stays where it was first placed
      const noteText = note?.(key);
      nodes.set(key, { key, label: shown(key), ...(noteText !== undefined && { note: noteText }), column, index, more: false });
    });
    if (hidden > 0) {
      nodes.set(`${column}:more`, { key: `${column}:more`, label: `+${hidden} more`, column, index: keys.length, more: true });
    }
  };
  const byPath = new Map(selection.files.map((f) => [f.path, f] as const));
  place(
    "changed",
    changed.shown.map((rel) => changedAbs.get(rel) ?? rel),
    changed.hidden,
    (key) => {
      const f = byPath.get(relativeTo(repo, key));
      if (!f) return undefined;
      if (f.status === "added") return "new file";
      if (f.status === "deleted") return "deleted";
      return f.symbols.length === 0 ? "whole file" : `${f.symbols.length} symbol${f.symbols.length === 1 ? "" : "s"}`;
    },
  );
  place("reached", reached.shown, reached.hidden);
  const editedTests = new Set(selection.files.filter((f) => f.disposition === "mapped" && isTest(f)).map((f) => f.path));
  place("test", test.shown, test.hidden, (key) => (editedTests.has(relativeTo(repo, key)) ? "edited" : undefined));

  // An edge to a folded file lands on that column's "+N more" node instead.
  const target = (abs: string): Node | undefined => {
    const direct = nodes.get(abs);
    if (direct) return direct;
    const asChanged = nodes.get(changedAbs.get(relativeTo(repo, abs)) ?? "");
    if (asChanged) return asChanged;
    if (selection.tests.includes(abs)) return nodes.get("test:more");
    if (selection.files.some((f) => f.reaches.some((r) => r.file === abs))) return nodes.get("reached:more");
    return undefined;
  };
  const drawn = new Set<string>();
  const edges: [string, string][] = [];
  for (const e of selection.edges) {
    const a = target(e.from);
    const b = target(e.to);
    if (!a || !b || a === b) continue;
    if (COLUMN_X[b.column] < COLUMN_X[a.column]) continue; // never draw against the dependency flow
    const key = `${a.key}>${b.key}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    edges.push([a.key, b.key]);
  }

  const symbolTotal = selection.files.filter((f) => !editedTests.has(f.path)).reduce((n, f) => n + f.symbols.length, 0);
  const reachedFiles = new Set<string>();
  for (const f of selection.files) for (const r of f.reaches) reachedFiles.add(r.file);
  const changedTotal = changed.shown.length + changed.hidden;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const captions: Record<Column, string> = {
    changed: `CHANGED  ${plural(changedTotal, "file")}, ${plural(symbolTotal, "symbol")}${editedTests.size > 0 ? `, ${plural(editedTests.size, "test")} edited` : ""}`,
    reached: `REACHES  ${plural(reachedFiles.size, "file")}, ${plural(selection.blast.length, "dependent")}`,
    test: `TESTS  ${selection.tests.length} of ${selection.testsTotal}`,
  };
  return { nodes: [...nodes.values()], edges, prefix, captions };
}

/** Render the reach figure as an SVG. Null when there is nothing to draw. */
export function renderFigure(selection: Selection, opts: FigureOptions): string | null {
  const l = layout(selection, opts.repo, opts.maxRows);
  if (l === null) return null;
  const t = PALETTE[opts.theme];
  const rowsOf = (c: Column): number => {
    const n = l.nodes.filter((node) => node.column === c).length;
    return n * NODE_H + (n - 1) * GAP;
  };
  const columnsHeight = Math.max(...COLUMNS.map(rowsOf));
  const height = TOP + columnsHeight + BOTTOM;
  const y0: Record<Column, number> = { changed: 0, reached: 0, test: 0 };
  for (const c of COLUMNS) y0[c] = TOP + (columnsHeight - rowsOf(c)) / 2;
  const pos = new Map(l.nodes.map((n) => [n.key, { x: COLUMN_X[n.column], y: y0[n.column] + n.index * (NODE_H + GAP) }]));
  const byKey = new Map(l.nodes.map((n) => [n.key, n]));

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12" role="img" aria-label="${esc(
      `${l.captions.changed}; ${l.captions.reached}; ${l.captions.test}`.toLowerCase(),
    )}">`,
    `<rect width="${WIDTH}" height="${height}" rx="6" fill="${t["bg"]}"/>`,
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${t["edge"]}"/></marker></defs>`,
  ];
  for (const c of COLUMNS) {
    out.push(`<text x="${COLUMN_X[c]}" y="24" fill="${t[c]}" font-weight="700" letter-spacing=".04em">${esc(l.captions[c])}</text>`);
  }
  for (const [from, to] of l.edges) {
    const a = byKey.get(from) as Node;
    const b = byKey.get(to) as Node;
    const pa = pos.get(from) as { x: number; y: number };
    const pb = pos.get(to) as { x: number; y: number };
    const ay = pa.y + NODE_H / 2;
    const by = pb.y + NODE_H / 2;
    if (a.column === b.column) {
      const cx = pa.x - 30;
      out.push(
        `<path d="M${pa.x},${ay} C${cx},${ay} ${cx},${by} ${pb.x},${by}" fill="none" stroke="${t["edge"]}" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#arrow)" opacity=".9"/>`,
      );
      continue;
    }
    const ax = pa.x + NODE_W[a.column];
    const mx = (ax + pb.x) / 2;
    out.push(
      `<path d="M${ax},${ay} C${mx},${ay} ${mx},${by} ${pb.x},${by}" fill="none" stroke="${t["edge"]}" stroke-width="1.2" marker-end="url(#arrow)" opacity=".8"/>`,
    );
  }
  for (const n of l.nodes) {
    const { x, y } = pos.get(n.key) as { x: number; y: number };
    const w = NODE_W[n.column];
    const color = t[n.column];
    out.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${NODE_H}" rx="4" fill="${t["panel"]}" stroke="${color}" stroke-width="1.4"${n.more ? ' stroke-dasharray="4 3"' : ""}/>`,
    );
    if (!n.more) out.push(`<rect x="${x}" y="${y}" width="4" height="${NODE_H}" rx="2" fill="${color}"/>`);
    const chars = Math.floor((w - 24 - (n.note?.length ?? 0) * 6) / CHAR_W);
    out.push(`<text x="${x + 12}" y="${y + 17}" fill="${n.more ? t["muted"] : t["fg"]}">${esc(fit(n.label, chars))}</text>`);
    if (n.note !== undefined) {
      out.push(`<text x="${x + w - 8}" y="${y + 17}" fill="${t["muted"]}" text-anchor="end" font-size="10">${esc(n.note)}</text>`);
    }
  }
  if (l.prefix) {
    out.push(`<text x="${COLUMN_X.changed}" y="${height - 10}" fill="${t["muted"]}" font-size="10">${esc(`paths under ${l.prefix} unless shown in full`)}</text>`);
  }
  if (opts.caption !== undefined) {
    out.push(`<text x="${WIDTH - 12}" y="${height - 10}" fill="${t["muted"]}" text-anchor="end" font-size="10">${esc(opts.caption)}</text>`);
  }
  out.push("</svg>");
  return out.join("\n");
}

/**
 * Mermaid node text: quoted, so paths with brackets and parentheses survive.
 * Inside quotes mermaid still reads `#…;` as an entity and a backtick as
 * markdown, so those two are entities themselves (`#` first, or it would
 * re-escape the others).
 */
function mermaidLabel(s: string): string {
  return `"${s.replace(/#/g, "#35;").replace(/"/g, "#quot;").replace(/`/g, "#96;")}"`;
}

/**
 * Render the same layout as a mermaid `graph LR` block for GitHub to draw
 * client-side, which works in private repositories where an image cannot be
 * fetched. Columns become shapes as well as colors: changed files are
 * double-bordered, tests are rounded, reached files plain, so the layers read
 * without color. Null when there is nothing to draw.
 */
export function renderMermaid(selection: Selection, opts: { repo: string; maxRows?: number }): string | null {
  const l = layout(selection, opts.repo, opts.maxRows);
  if (l === null) return null;
  const id = new Map(l.nodes.map((n, i) => [n.key, `n${i}`]));
  const shape = (n: Node): string => {
    const text = mermaidLabel(n.note !== undefined && !n.more ? `${n.label}  (${n.note})` : n.label);
    if (n.column === "changed") return `[[${text}]]`;
    if (n.column === "test") return `([${text}])`;
    return `[${text}]`;
  };
  const lines = ["graph LR"];
  for (const n of l.nodes) lines.push(`  ${id.get(n.key)}${shape(n)}`);
  for (const [from, to] of l.edges) lines.push(`  ${id.get(from)} --> ${id.get(to)}`);
  lines.push(
    "  classDef changed fill:#f5a651,stroke:#b35900,color:#1f2328",
    "  classDef reached fill:#a5c8ff,stroke:#0969da,color:#1f2328",
    "  classDef test fill:#8ee0b8,stroke:#1a7f37,color:#1f2328",
    "  classDef more fill:none,stroke:#8b949e,stroke-dasharray:4 3,color:#8b949e",
  );
  for (const c of COLUMNS) {
    const members = l.nodes.filter((n) => n.column === c && !n.more).map((n) => id.get(n.key));
    if (members.length > 0) lines.push(`  class ${members.join(",")} ${c}`);
  }
  const folds = l.nodes.filter((n) => n.more).map((n) => id.get(n.key));
  if (folds.length > 0) lines.push(`  class ${folds.join(",")} more`);
  return lines.join("\n");
}
