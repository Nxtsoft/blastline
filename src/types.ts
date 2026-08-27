/** A contiguous range of changed lines in one file, from a unified diff. */
export interface ChangedRange {
  /** 1-indexed first changed line in the new file (or old file for pure deletions). */
  start: number;
  /** 1-indexed last changed line; equal to start for single-line changes. */
  end: number;
  /** True when the range describes lines removed from the base side only. */
  deletion: boolean;
}

/** All changed ranges for one file in a diff. */
export interface ChangedFile {
  /** Path on the head side, or the base path when the file was deleted. */
  path: string;
  /** Base-side path when the file was renamed; otherwise same as path. */
  oldPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  ranges: ChangedRange[];
  /**
   * Verbatim `+` line contents, in order, with the marker stripped. Populated
   * for every file; consumed only by readers that need to understand a file the
   * graph has no node for (see `cmake.ts`). Line ranges remain the mapping
   * mechanism for everything the graph does cover.
   */
  added?: string[];
  /** Verbatim `-` line contents, in order, with the marker stripped. */
  removed?: string[];
}

/** Why a run fell open to selecting the full test suite. */
export type FailOpenReason =
  | { kind: "unmapped-file"; path: string }
  | { kind: "stale-graph"; expected: string; actual: string }
  | { kind: "extraction-warning"; path: string }
  | { kind: "diff-too-large"; files: number; limit: number }
  | { kind: "sparse-graph"; edgesPerFile: number; threshold: number }
  | { kind: "disconnected-tests"; coverage: number; threshold: number }
  | { kind: "graph-unavailable"; detail: string }
  | { kind: "invalid-ignore-pattern"; pattern: string; detail: string };

/** The outcome of a selection: either a concrete test set or ALL with reasons. */
export type Selection =
  | {
      kind: "subset";
      tests: string[];
      blast: string[];
      /** sha256-merkle-v1 root of the tree the selection was computed from, when the graph carries one */
      contentRoot?: string;
    }
  | { kind: "all"; reasons: FailOpenReason[] };
