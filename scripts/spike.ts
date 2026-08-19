/**
 * Phase-1 spike (proposal task 1): validate diff→node mapping and impact
 * intersection against a real CGraph graph.json.
 *
 * Usage: bun scripts/spike.ts --repo <path> --graph <graph.json> --range <base>..<head>
 *        bun scripts/spike.ts --repo <path> --graph <graph.json> --diff-file <unified0.patch>
 *
 * Not production code: no fail-open rules, head-graph-only (deletion ranges are
 * mapped against the head graph and reported unmapped when the span is gone).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseUnifiedDiff } from "../src/diff.js";
import type { ChangedFile } from "../src/types.js";

interface GNode {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  source_location?: { start_line: number; end_line: number };
}
interface GLink {
  source: string;
  target: string;
  relation: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const repo = arg("repo");
const graphPath = arg("graph");
const range = arg("range");
const diffFile = arg("diff-file");
if (!repo || !graphPath || (!range && !diffFile)) {
  console.error("usage: spike.ts --repo <path> --graph <graph.json> (--range a..b | --diff-file f.patch)");
  process.exit(2);
}

const diffText = diffFile
  ? readFileSync(diffFile, "utf8")
  : execFileSync("git", ["-C", repo, "diff", "--unified=0", range as string], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
const changed: ChangedFile[] = parseUnifiedDiff(diffText);

const g = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes: GNode[]; links: GLink[] };

// Index nodes by repo-relative suffix of their source_file.
const bySuffix = new Map<string, GNode[]>();
for (const n of g.nodes) {
  if (!n.source_file) continue;
  const list = bySuffix.get(n.source_file) ?? [];
  list.push(n);
  bySuffix.set(n.source_file, list);
}
function nodesForPath(relPath: string): GNode[] {
  for (const [abs, nodes] of bySuffix) if (abs.endsWith(`/${relPath}`)) return nodes;
  return [];
}

// Reverse adjacency: X --rel--> N means X depends on N (CALLS caller->callee,
// imports importer->imported, contains parent->child: parent's content includes child).
const incoming = new Map<string, string[]>();
for (const l of g.links) {
  const list = incoming.get(l.target) ?? [];
  list.push(l.source);
  incoming.set(l.target, list);
}
function dependents(seed: string[]): Set<string> {
  const seen = new Set<string>(seed);
  const queue = [...seed];
  while (queue.length) {
    const cur = queue.pop() as string;
    for (const dep of incoming.get(cur) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  for (const s of seed) seen.delete(s);
  return seen;
}

const isTestFile = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes("__tests__/");
const nodeById = new Map(g.nodes.map((n) => [n.id, n]));

let mappedRanges = 0;
let fileLevelRanges = 0;
let unmappedFiles = 0;
const seeds = new Set<string>();

console.log(`diff: ${changed.length} changed files\n`);
for (const file of changed) {
  const candidates = nodesForPath(file.status === "deleted" ? file.oldPath : file.path);
  if (candidates.length === 0) {
    unmappedFiles++;
    console.log(`UNMAPPED  ${file.path} (${file.status}) — no graph node (fail-open in real tool)`);
    continue;
  }
  const fileNode = candidates.find((n) => n.type === "file");
  for (const r of file.ranges) {
    const containing = candidates.filter(
      (n) =>
        n.type !== "file" &&
        n.source_location &&
        n.source_location.start_line <= r.end &&
        n.source_location.end_line >= r.start,
    );
    containing.sort(
      (a, b) =>
        a.source_location!.end_line - a.source_location!.start_line -
        (b.source_location!.end_line - b.source_location!.start_line),
    );
    const best = containing[0];
    if (best) {
      mappedRanges++;
      seeds.add(best.id);
      console.log(
        `MAPPED    ${file.path}:${r.start}-${r.end}${r.deletion ? " (del)" : ""} -> ${best.type} ${best.label} [${best.source_location!.start_line}-${best.source_location!.end_line}]` +
          (containing.length > 1 ? ` (won over ${containing.length - 1} wider)` : ""),
      );
    } else if (fileNode) {
      fileLevelRanges++;
      seeds.add(fileNode.id);
      console.log(`FILE-LVL  ${file.path}:${r.start}-${r.end}${r.deletion ? " (del)" : ""} -> file ${fileNode.label}`);
    }
  }
}

const blast = dependents([...seeds]);
const blastNodes = [...blast].map((id) => nodeById.get(id)).filter((n): n is GNode => !!n);
const impactedTests = blastNodes.filter((n) => n.source_file && isTestFile(n.source_file));

console.log(`\n--- summary ---`);
console.log(`ranges mapped to symbol: ${mappedRanges}, to file: ${fileLevelRanges}, files unmapped: ${unmappedFiles}`);
console.log(`seed nodes: ${seeds.size}, transitive dependents: ${blast.size}`);
console.log(`blast (first 15): ${blastNodes.slice(0, 15).map((n) => `${n.type}:${n.label}`).join(", ")}`);
console.log(`impacted test nodes: ${impactedTests.length}`);
for (const t of impactedTests) console.log(`  TEST ${t.type}:${t.label} (${t.source_file})`);
