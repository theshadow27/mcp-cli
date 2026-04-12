/**
 * Parse git fast-import streams into structured commits with file changes.
 *
 * Consumes the stream git sends over stdin during `git push` (when the remote
 * helper advertises the `export` capability) and produces plain data the
 * export handler can route to provider.push()/create()/delete().
 *
 * See: https://git-scm.com/docs/git-fast-import
 *
 * The parser operates on bytes, not strings: git fast-import is a binary
 * protocol (`data <n>` counts bytes, blobs may be arbitrary). Callers should
 * pass a Uint8Array; a string input is accepted for convenience and encoded as
 * UTF-8, which is safe for text-only streams.
 */

export type ParsedChange =
  | { type: "modify"; path: string; mode?: string; dataref?: string; content?: Uint8Array }
  | { type: "delete"; path: string }
  | { type: "deleteall" };

export interface ParsedCommit {
  ref: string;
  mark?: string;
  author?: string;
  committer?: string;
  message: string;
  from?: string;
  merge?: string[];
  changes: ParsedChange[];
}

/** Parse a fast-import stream into commits. Blobs referenced by mark are inlined into changes. */
export function parseFastImport(stream: string | Uint8Array): ParsedCommit[] {
  const bytes = typeof stream === "string" ? new TextEncoder().encode(stream) : stream;
  const blobs = new Map<string, Uint8Array>();
  const commits: ParsedCommit[] = [];
  const state = { pos: 0 };

  while (state.pos < bytes.length) {
    const line = readLine(bytes, state);
    if (line === null || line === "") continue;
    if (line.startsWith("#")) continue;

    if (line === "blob") {
      parseBlob(bytes, state, blobs);
    } else if (line.startsWith("commit ")) {
      commits.push(parseCommit(line.slice("commit ".length), bytes, state, blobs));
    } else if (line.startsWith("tag ")) {
      skipTag(bytes, state);
    } else if (line.startsWith("reset ")) {
      const next = peekLine(bytes, state);
      if (next?.startsWith("from ")) readLine(bytes, state);
    }
    // Other directives (feature, option, done, progress, ls, cat-blob, get-mark,
    // alias, checkpoint) carry no payload we care about — fall through and
    // continue the top-level loop.
  }

  return commits;
}

function parseBlob(bytes: Uint8Array, state: { pos: number }, blobs: Map<string, Uint8Array>): void {
  let mark: string | undefined;
  while (true) {
    const p = peekLine(bytes, state);
    if (p?.startsWith("mark ")) {
      readLine(bytes, state);
      // Mark lines are written as "mark :N" — strip the leading colon so
      // lookups by dataref can share the same key space.
      mark = p.slice("mark ".length).replace(/^:/, "");
    } else if (p?.startsWith("original-oid ")) {
      readLine(bytes, state);
    } else {
      break;
    }
  }
  const content = readDataBytes(bytes, state);
  if (mark) blobs.set(mark, content);
}

function parseCommit(
  ref: string,
  bytes: Uint8Array,
  state: { pos: number },
  blobs: Map<string, Uint8Array>,
): ParsedCommit {
  const commit: ParsedCommit = { ref, message: "", changes: [] };

  // Header: mark, original-oid, author, committer, data (message), from, merge
  while (true) {
    const p = peekLine(bytes, state);
    if (p === null) break;
    if (p.startsWith("mark ")) {
      readLine(bytes, state);
      commit.mark = p.slice("mark ".length);
    } else if (p.startsWith("original-oid ")) {
      readLine(bytes, state);
    } else if (p.startsWith("author ")) {
      readLine(bytes, state);
      commit.author = p.slice("author ".length);
    } else if (p.startsWith("committer ")) {
      readLine(bytes, state);
      commit.committer = p.slice("committer ".length);
    } else if (p === "data" || p.startsWith("data ")) {
      commit.message = readDataString(bytes, state);
    } else if (p.startsWith("from ")) {
      readLine(bytes, state);
      commit.from = p.slice("from ".length);
    } else if (p.startsWith("merge ")) {
      readLine(bytes, state);
      commit.merge ??= [];
      commit.merge.push(p.slice("merge ".length));
    } else {
      break;
    }
  }

  // Change list: M, D, R, C, deleteall, filedeleteall
  while (true) {
    const p = peekLine(bytes, state);
    if (p === null) break;
    if (p === "") {
      readLine(bytes, state);
      break;
    }

    if (p.startsWith("M ")) {
      readLine(bytes, state);
      const change = parseModify(p.slice("M ".length), bytes, state, blobs);
      if (change) commit.changes.push(change);
    } else if (p.startsWith("D ")) {
      readLine(bytes, state);
      commit.changes.push({ type: "delete", path: unquotePath(p.slice("D ".length)) });
    } else if (p === "deleteall" || p === "filedeleteall") {
      // Tree reset — emitted by git filter-repo / filter-branch secret-removal
      // and by --reencode runs. Downstream must clear the tree before applying
      // the following M entries.
      readLine(bytes, state);
      commit.changes.push({ type: "deleteall" });
    } else if (p.startsWith("R ") || p.startsWith("C ")) {
      // Rename/copy: we don't request rename detection, so these are rare.
      // Swallow gracefully rather than crashing.
      readLine(bytes, state);
    } else {
      break;
    }
  }

  return commit;
}

function parseModify(
  rest: string,
  bytes: Uint8Array,
  state: { pos: number },
  blobs: Map<string, Uint8Array>,
): ParsedChange | null {
  // M <mode> <dataref> <path>   —   path may be C-quoted if it contains special chars
  const sp1 = rest.indexOf(" ");
  const sp2 = rest.indexOf(" ", sp1 + 1);
  if (sp1 === -1 || sp2 === -1) return null;
  const mode = rest.slice(0, sp1);
  const dataref = rest.slice(sp1 + 1, sp2);
  const path = unquotePath(rest.slice(sp2 + 1));

  let content: Uint8Array | undefined;
  if (dataref === "inline") {
    content = readDataBytes(bytes, state);
  } else if (dataref.startsWith(":")) {
    content = blobs.get(dataref.slice(1));
  }
  // For raw SHA-1 datarefs we leave content undefined — git fast-export only
  // emits those when referencing objects already known to git, which doesn't
  // happen for streams written to a foreign remote helper.

  return { type: "modify", path, mode, dataref, content };
}

function skipTag(bytes: Uint8Array, state: { pos: number }): void {
  while (true) {
    const p = peekLine(bytes, state);
    if (p === null) return;
    if (p === "data" || p.startsWith("data ")) {
      readDataBytes(bytes, state);
      return;
    }
    // Consume every other line — tag bodies include `from`, `mark`,
    // `original-oid`, `tagger`, and for signed tags a PGP signature block
    // before the `data` payload. We don't care about the content.
    readLine(bytes, state);
  }
}

/** Read one LF-terminated line, decoded as UTF-8. Returns null at EOF. */
function readLine(bytes: Uint8Array, state: { pos: number }): string | null {
  if (state.pos >= bytes.length) return null;
  const start = state.pos;
  while (state.pos < bytes.length && bytes[state.pos] !== 0x0a) state.pos++;
  const line = new TextDecoder().decode(bytes.subarray(start, state.pos));
  if (state.pos < bytes.length) state.pos++;
  return line;
}

function peekLine(bytes: Uint8Array, state: { pos: number }): string | null {
  const save = state.pos;
  const line = readLine(bytes, state);
  state.pos = save;
  return line;
}

/**
 * Read a `data <n>\n<n bytes>` or `data <<DELIM\n...lines...\nDELIM\n` payload
 * and return the raw bytes. Used for blobs (which may be binary) and for
 * tag payloads we skip.
 */
function readDataBytes(bytes: Uint8Array, state: { pos: number }): Uint8Array {
  const header = readLine(bytes, state);
  if (header === null || (header !== "data" && !header.startsWith("data "))) {
    throw new Error(`fast-import: expected "data", got: ${header ?? "<eof>"}`);
  }
  const spec = header.slice("data ".length);
  if (spec.startsWith("<<")) {
    const delim = spec.slice(2);
    const parts: Uint8Array[] = [];
    while (true) {
      const lineStart = state.pos;
      const line = readLine(bytes, state);
      if (line === null || line === delim) break;
      const lineEnd = state.pos; // includes the LF if present
      parts.push(bytes.subarray(lineStart, lineEnd));
    }
    return concatBytes(parts);
  }
  const n = Number.parseInt(spec, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`fast-import: invalid data length: ${spec}`);
  const end = state.pos + n;
  if (end > bytes.length) throw new Error(`fast-import: data length ${n} exceeds stream`);
  const content = bytes.subarray(state.pos, end);
  state.pos = end;
  // fast-import allows an optional trailing LF after the data block
  if (state.pos < bytes.length && bytes[state.pos] === 0x0a) state.pos++;
  return content;
}

/** Like readDataBytes, but decodes to UTF-8 string. Used for commit messages. */
function readDataString(bytes: Uint8Array, state: { pos: number }): string {
  return new TextDecoder().decode(readDataBytes(bytes, state));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Decode a path written in git's C-style quoting (used when the path contains
 * double-quotes, backslashes, control chars, or non-ASCII bytes).
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = inner[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "a") out += "\x07";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "v") out += "\v";
    else if (next === "\\" || next === '"') out += next;
    else if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
        oct += inner[++i];
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
    } else if (next === "x") {
      const hex = inner.slice(i + 1, i + 3);
      i += 2;
      out += String.fromCharCode(Number.parseInt(hex, 16));
    } else {
      out += next;
    }
  }
  return out;
}
