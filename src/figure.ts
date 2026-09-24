import { relativeTo, sharedDir } from "./paths.js";
import type { ChangedFileImpact, FileEdge, Selection } from "./types.js";

/**
 * The reach figure: what the diff touched, what that reaches, and which tests
 * sit at the end, as one SVG the PR comment embeds. File-level on purpose --
 * symbol-level graphs of a real PR run to hundreds of nodes and explain
 * nothing at comment width.
 *
 * Layout is deliberate rather than delegated to a graph layout engine: three
 * fixed columns (changed, reached, tests) in dependency order, one row per
 * file, a cap per column with a "+N more" node so a wide PR stays legible, and
 * same-column dependencies drawn as dashed arcs on the column's left so they
 * never cross the column's outgoing edges.
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

interface Node {
  key: string;
  label: string;
  note?: string;
  column: Column;
  x: number;
  y: number;
}

/**
 * Pick the rows each column shows. Changed files come first in diff order;
 * reached and test files are ordered by how many changed files reach them, so
 * the fold keeps the most connected ones visible.
 */
function rows(files: ChangedFileImpact[], tests: string[], edges: FileEdge[], maxRows: number) {
  // An edited test file is drawn once, in the tests column, where it will run.
  const isTest = (f: ChangedFileImpact): boolean => f.tests.some((t) => t.endsWith(`/${f.path}`) || t === f.path);
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

/** Render the reach figure for a subset selection. Null when there is nothing to draw: fail-open, or no mapped file. */
export function renderFigure(selection: Selection, opts: FigureOptions): string | null {
  if (selection.kind !== "subset") return null;
  // Nothing mapped (every changed file ignored by policy) leaves no node to
  // draw: three captions over an empty box explain less than no figure.
  if (!selection.files.some((f) => f.disposition === "mapped")) return null;
  const t = PALETTE[opts.theme];
  const maxRows = opts.maxRows ?? 12;
  const { changed, reached, test } = rows(selection.files, selection.tests, selection.edges, maxRows);

  // Changed rows are repo-relative already; reached/test rows are absolute.
  const changedAbs = new Map<string, string>();
  for (const e of selection.edges) {
    for (const abs of [e.from, e.to]) {
      const rel = relativeTo(opts.repo, abs);
      if (changed.shown.includes(rel)) changedAbs.set(rel, abs);
    }
  }

  const rowsOf = (c: Column): number => {
    const list = c === "changed" ? changed : c === "reached" ? reached : test;
    const n = list.shown.length + (list.hidden > 0 ? 1 : 0);
    return n * NODE_H + (n - 1) * GAP;
  };
  const columnsHeight = Math.max(...(["changed", "reached", "test"] as Column[]).map(rowsOf));
  const height = TOP + columnsHeight + BOTTOM;

  const nodes = new Map<string, Node>();
  const prefix = sharedDir([
    ...changed.shown,
    ...reached.shown.map((p) => relativeTo(opts.repo, p)),
    ...test.shown.map((p) => relativeTo(opts.repo, p)),
  ]);
  const shown = (key: string): string => {
    const rel = relativeTo(opts.repo, key);
    return prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
  };
  const place = (column: Column, keys: string[], hidden: number, note?: (key: string) => string | undefined) => {
    const n = keys.length + (hidden > 0 ? 1 : 0);
    const total = n * NODE_H + (n - 1) * GAP;
    const y0 = TOP + (columnsHeight - total) / 2;
    keys.forEach((key, i) => {
      if (nodes.has(key)) return; // a file drawn once stays where it was first placed
      const noteText = note?.(key);
      const chars = Math.floor((NODE_W[column] - 24 - (noteText?.length ?? 0) * 6) / CHAR_W);
      nodes.set(key, {
        key,
        label: fit(shown(key), chars),
        ...(noteText !== undefined && { note: noteText }),
        column,
        x: COLUMN_X[column],
        y: y0 + i * (NODE_H + GAP),
      });
    });
    if (hidden > 0) {
      nodes.set(`${column}:more`, {
        key: `${column}:more`,
        label: `+${hidden} more`,
        column,
        x: COLUMN_X[column],
        y: y0 + keys.length * (NODE_H + GAP),
      });
    }
  };

  const byPath = new Map(selection.files.map((f) => [f.path, f] as const));
  place(
    "changed",
    changed.shown.map((rel) => changedAbs.get(rel) ?? rel),
    changed.hidden,
    (key) => {
      const f = byPath.get(relativeTo(opts.repo, key));
      if (!f) return undefined;
      if (f.status === "added") return "new file";
      if (f.status === "deleted") return "deleted";
      return f.symbols.length === 0 ? "whole file" : `${f.symbols.length} symbol${f.symbols.length === 1 ? "" : "s"}`;
    },
  );
  place("reached", reached.shown, reached.hidden);
  const editedTests = new Set(
    selection.files.filter((f) => f.disposition === "mapped" && f.tests.some((t) => t.endsWith(`/${f.path}`) || t === f.path)).map((f) => f.path),
  );
  place("test", test.shown, test.hidden, (key) => (editedTests.has(relativeTo(opts.repo, key)) ? "edited" : undefined));

  // An edge to a folded file lands on that column's "+N more" node instead.
  const target = (abs: string): Node | undefined => {
    const direct = nodes.get(abs);
    if (direct) return direct;
    const rel = relativeTo(opts.repo, abs);
    const asChanged = nodes.get(changedAbs.get(rel) ?? "");
    if (asChanged) return asChanged;
    if (selection.tests.includes(abs)) return nodes.get("test:more");
    if (selection.files.some((f) => f.reaches.some((r) => r.file === abs))) return nodes.get("reached:more");
    return undefined;
  };
  const drawn = new Set<string>();
  const paths: string[] = [];
  for (const e of selection.edges) {
    const a = target(e.from);
    const b = target(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a.key}>${b.key}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const ay = a.y + NODE_H / 2;
    const by = b.y + NODE_H / 2;
    if (a.column === b.column) {
      const cx = a.x - 30;
      paths.push(
        `<path d="M${a.x},${ay} C${cx},${ay} ${cx},${by} ${b.x},${by}" fill="none" stroke="${t["edge"]}" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#arrow)" opacity=".9"/>`,
      );
      continue;
    }
    if (COLUMN_X[b.column] < COLUMN_X[a.column]) continue; // never draw against the dependency flow
    const ax = a.x + NODE_W[a.column];
    const mx = (ax + b.x) / 2;
    paths.push(
      `<path d="M${ax},${ay} C${mx},${ay} ${mx},${by} ${b.x},${by}" fill="none" stroke="${t["edge"]}" stroke-width="1.2" marker-end="url(#arrow)" opacity=".8"/>`,
    );
  }

  const symbolTotal = selection.files
    .filter((f) => !editedTests.has(f.path))
    .reduce((n, f) => n + f.symbols.length, 0);
  const reachedFiles = new Set<string>();
  for (const f of selection.files) for (const r of f.reaches) reachedFiles.add(r.file);
  const captions: [Column, string][] = [
    [
      "changed",
      `CHANGED  ${changed.shown.length + changed.hidden} file${changed.shown.length + changed.hidden === 1 ? "" : "s"}, ${symbolTotal} symbol${symbolTotal === 1 ? "" : "s"}${editedTests.size > 0 ? `, ${editedTests.size} test${editedTests.size === 1 ? "" : "s"} edited` : ""}`,
    ],
    ["reached", `REACHES  ${reachedFiles.size} file${reachedFiles.size === 1 ? "" : "s"}, ${selection.blast.length} dependent${selection.blast.length === 1 ? "" : "s"}`],
    ["test", `TESTS  ${selection.tests.length} of ${selection.testsTotal}`],
  ];

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12" role="img" aria-label="${esc(
      `${changed.shown.length + changed.hidden} changed files reach ${reachedFiles.size} files and ${selection.tests.length} of ${selection.testsTotal} tests`,
    )}">`,
    `<rect width="${WIDTH}" height="${height}" rx="6" fill="${t["bg"]}"/>`,
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${t["edge"]}"/></marker></defs>`,
  ];
  for (const [column, text] of captions) {
    out.push(`<text x="${COLUMN_X[column]}" y="24" fill="${t[column]}" font-weight="700" letter-spacing=".04em">${esc(text)}</text>`);
  }
  out.push(...paths);
  for (const n of nodes.values()) {
    const w = NODE_W[n.column];
    const color = t[n.column];
    const more = n.key.endsWith(":more");
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${w}" height="${NODE_H}" rx="4" fill="${t["panel"]}" stroke="${color}" stroke-width="1.4"${more ? ' stroke-dasharray="4 3"' : ""}/>`,
    );
    if (!more) out.push(`<rect x="${n.x}" y="${n.y}" width="4" height="${NODE_H}" rx="2" fill="${color}"/>`);
    out.push(`<text x="${n.x + 12}" y="${n.y + 17}" fill="${more ? t["muted"] : t["fg"]}">${esc(n.label)}</text>`);
    if (n.note !== undefined) {
      out.push(`<text x="${n.x + w - 8}" y="${n.y + 17}" fill="${t["muted"]}" text-anchor="end" font-size="10">${esc(n.note)}</text>`);
    }
  }
  if (prefix) {
    out.push(`<text x="${COLUMN_X.changed}" y="${height - 10}" fill="${t["muted"]}" font-size="10">${esc(`paths under ${prefix} unless shown in full`)}</text>`);
  }
  if (opts.caption !== undefined) {
    out.push(`<text x="${WIDTH - 12}" y="${height - 10}" fill="${t["muted"]}" text-anchor="end" font-size="10">${esc(opts.caption)}</text>`);
  }
  out.push("</svg>");
  return out.join("\n");
}
