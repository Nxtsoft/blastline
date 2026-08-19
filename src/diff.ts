import type { ChangedFile, ChangedRange } from "./types.js";

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0 base..head` output into changed line ranges.
 *
 * With zero context lines every hunk is exactly a changed range: the new-side
 * span for additions/modifications, and the old-side position for pure
 * deletions (new-side count of 0).
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let sawDeletedFile = false;
  let sawNewFile = false;

  for (const line of text.split("\n")) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      const oldPath = fileMatch[1] as string;
      const newPath = fileMatch[2] as string;
      current = {
        path: newPath,
        oldPath,
        status: oldPath === newPath ? "modified" : "renamed",
        ranges: [],
      };
      files.push(current);
      sawDeletedFile = false;
      sawNewFile = false;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("deleted file mode")) {
      sawDeletedFile = true;
      current.status = "deleted";
      current.path = current.oldPath;
      continue;
    }
    if (line.startsWith("new file mode")) {
      sawNewFile = true;
      current.status = "added";
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);

      let range: ChangedRange;
      if (newCount === 0) {
        // Pure deletion: anchor to the old-side span so the base graph can map it.
        range = { start: oldStart, end: oldStart + Math.max(oldCount, 1) - 1, deletion: true };
      } else {
        range = { start: newStart, end: newStart + newCount - 1, deletion: false };
      }
      current.ranges.push(range);
    }
  }

  // A file that is entirely new or entirely deleted may carry both flags' hunks;
  // status was already settled above, so nothing further to reconcile.
  void sawDeletedFile;
  void sawNewFile;
  return files;
}
