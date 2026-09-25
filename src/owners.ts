import { execFileSync } from "node:child_process";
import { agentForAddress } from "./checkpoint.js";

/** Who last changed a set of files, by the human commits in their history. */
export interface Owners {
  /** Files asked about, repo-relative. */
  files: number;
  /** Human commits read, after agent-authored ones were set aside. */
  commits: number;
  /** Commits an agent authored, set aside: a vendor address as author, or Copilot's `Agent-Logs-Url:` trailer. */
  agentCommits: number;
  /** Humans by commits touching the files, most first; `files` counts the distinct files each touched. */
  authors: { name: string; commits: number; files: number }[];
}

const CLOUD_AGENT = /^Agent-Logs-Url:/m;

/**
 * A commit an agent authored: a vendor address as the author, or Copilot's
 * cloud-agent trailer. A human's commit that carries an agent co-author or a
 * checkpoint is the human's: they directed the change and committed it, and
 * that is the knowledge of the code the row is after.
 */
export function agentCommit(authorEmail: string, body: string): boolean {
  return agentForAddress(authorEmail) !== undefined || CLOUD_AGENT.test(body);
}

/**
 * The humans who last changed `files`, from the history that ends at `upTo`
 * (the base of the range, so the range's own commits do not count), reading
 * at most `limit` commits that touch them. One `git log` call; a file with no
 * history simply contributes no author.
 */
export function ownersOf(repo: string, upTo: string, files: string[], limit = 300): Owners {
  const wanted = new Set(files);
  const empty: Owners = { files: files.length, commits: 0, agentCommits: 0, authors: [] };
  if (files.length === 0) return empty;
  let log: string;
  try {
    log = execFileSync(
      "git",
      ["-C", repo, "log", "--no-merges", `-n${limit}`, "--format=%x1e%an%x00%ae%x00%B%x00", "--name-only", upTo, "--", ...files],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return empty;
  }
  const commitsBy = new Map<string, number>();
  const filesBy = new Map<string, Set<string>>();
  let commits = 0;
  let agentCommits = 0;
  for (const record of log.split("\x1e")) {
    if (record.trim() === "") continue;
    const [name = "", email = "", body = "", rest = ""] = record.split("\0");
    const touched = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => wanted.has(l));
    if (touched.length === 0) continue;
    if (agentCommit(email, body)) {
      agentCommits++;
      continue;
    }
    commits++;
    commitsBy.set(name, (commitsBy.get(name) ?? 0) + 1);
    const seen = filesBy.get(name) ?? new Set<string>();
    for (const f of touched) seen.add(f);
    filesBy.set(name, seen);
  }
  const authors = [...commitsBy.entries()]
    .map(([name, n]) => ({ name, commits: n, files: filesBy.get(name)?.size ?? 0 }))
    .sort((a, b) => b.commits - a.commits || b.files - a.files || a.name.localeCompare(b.name));
  return { files: files.length, commits, agentCommits, authors };
}
