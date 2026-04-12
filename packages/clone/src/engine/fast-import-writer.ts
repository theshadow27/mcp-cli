/**
 * Generate a git fast-import stream from a flat list of entries.
 *
 * The stream format is documented at https://git-scm.com/docs/git-fast-import.
 * For each entry we emit a `blob` command with a mark, then a single `commit`
 * command that references each blob via its mark in a filemodify (`M`) line.
 */

export interface FastImportEntry {
  path: string;
  content: string;
}

export interface GenerateFastImportOptions {
  entries: FastImportEntry[];
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  /** Commit message body. */
  message: string;
  /** Optional parent — either a mark (`:42`) or a 40-char sha1. */
  parent?: string;
  /** First mark number to use for blobs. Defaults to 1. */
  startMark?: number;
  /** Commit mark number. Defaults to startMark + entries.length. */
  commitMark?: number;
  /** Committer identity. Defaults to `mcx <mcx@local>`. */
  committerName?: string;
  committerEmail?: string;
  /** Commit timestamp (unix seconds). Defaults to 0 for deterministic output. */
  timestamp?: number;
}

export interface GenerateFastImportResult {
  /** The fast-import stream as a string. */
  stream: string;
  /** Map of path → mark used for its blob. */
  marks: Record<string, number>;
  /** The mark used for the commit itself. */
  commitMark: number;
}

/**
 * Generate a fast-import stream. Pure function — same inputs produce the same output.
 */
export function generateFastImport(opts: GenerateFastImportOptions): GenerateFastImportResult {
  const startMark = opts.startMark ?? 1;
  const committerName = opts.committerName ?? "mcx";
  const committerEmail = opts.committerEmail ?? "mcx@local";
  const timestamp = opts.timestamp ?? 0;
  const encoder = new TextEncoder();

  const parts: string[] = [];
  const marks: Record<string, number> = {};

  opts.entries.forEach((entry, i) => {
    const mark = startMark + i;
    marks[entry.path] = mark;
    const byteLen = encoder.encode(entry.content).length;
    parts.push(`blob\nmark :${mark}\ndata ${byteLen}\n${entry.content}\n`);
  });

  const commitMark = opts.commitMark ?? startMark + opts.entries.length;
  const messageBytes = encoder.encode(opts.message).length;

  let commit = "";
  commit += `commit ${opts.ref}\n`;
  commit += `mark :${commitMark}\n`;
  commit += `committer ${committerName} <${committerEmail}> ${timestamp} +0000\n`;
  commit += `data ${messageBytes}\n${opts.message}\n`;
  if (opts.parent) {
    commit += `from ${opts.parent}\n`;
    // Reset the tree so only the listed entries survive — callers that want
    // incremental updates should pass their own M/D lines via a different API.
    commit += "deleteall\n";
  }
  for (const entry of opts.entries) {
    const mark = marks[entry.path];
    commit += `M 100644 :${mark} ${entry.path}\n`;
  }
  commit += "\n";
  parts.push(commit);
  parts.push("done\n");

  return { stream: parts.join(""), marks, commitMark };
}

/**
 * Parse a marks file (`:<mark> <sha1>` per line) into a Map.
 * Lines that don't match the format are ignored.
 */
export function parseMarksFile(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^:(\d+)\s+([0-9a-f]{40})$/);
    if (m) out.set(Number.parseInt(m[1], 10), m[2]);
  }
  return out;
}

/** Serialize a marks map back to the on-disk format. */
export function formatMarksFile(marks: Map<number, string>): string {
  const lines: string[] = [];
  for (const [mark, sha] of Array.from(marks.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(`:${mark} ${sha}`);
  }
  return `${lines.join("\n")}\n`;
}
