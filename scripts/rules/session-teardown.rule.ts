/**
 * Rule: session-teardown
 *
 * `this.sessions.delete(...)` must appear BEFORE the first `await` in any
 * async method that calls it. In single-threaded JS, code before the first
 * `await` runs atomically; once an await yields, other microtasks can run.
 * A concurrent teardown that starts during the yield will still see the
 * session in the map — a TOCTOU race causing double-cleanup or orphaned
 * worktrees (see #1837, fixed in #1895).
 *
 * Scoped to `packages/` (where session worker classes live). Detection:
 *   1. Find every async method/function (handles access modifiers and
 *      multi-line signatures, including object return-type annotations
 *      like `Promise<{ ... }>`).
 *   2. For each region, walk linearly: if `this.sessions.delete(...)`
 *      appears after the first `await`, flag it.
 *
 * Comments are ignored when scanning for await/delete — both
 * line-comment lines and the trailing portion of inline comments.
 *
 * Migrated from the standalone `scripts/check-session-teardown.ts`.
 */

import type { CheckRule } from "./_engine/rule";

const ASYNC_METHOD_RE =
  /\b(?:(?:private|public|protected|static|override|abstract)\s+)*async\s+(?:function\s+)?(\w+)\s*\(/;
const SESSIONS_DELETE_RE = /\bthis\.sessions\.delete\s*\(/;
const AWAIT_RE = /\bawait\b/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function stripInlineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx !== -1 ? line.slice(0, idx) : line;
}

interface MethodRegion {
  name: string;
  startLine: number;
  endLine: number;
}

export function findAsyncMethods(lines: string[]): MethodRegion[] {
  const regions: MethodRegion[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (isCommentLine(line)) {
      i++;
      continue;
    }

    const m = ASYNC_METHOD_RE.exec(line);
    if (!m) {
      i++;
      continue;
    }

    const methodName = m[1];

    let bodyStart = -1;
    let bodyStartCol = -1;
    let parenDepth = 0;
    let seenOpenParen = false;
    let angleBracketDepth = 0;

    outer: for (let j = i; j < Math.min(i + 20, lines.length); j++) {
      const fullLine = lines[j] ?? "";
      const segment = j === i ? fullLine.slice(m.index) : fullLine;
      const segmentOffset = j === i ? m.index : 0;
      for (let ci = 0; ci < segment.length; ci++) {
        const ch = segment[ci];
        if (ch === "(") {
          parenDepth++;
          seenOpenParen = true;
        } else if (ch === ")") {
          parenDepth--;
        } else if (ch === "<") {
          angleBracketDepth++;
        } else if (ch === ">") {
          if (angleBracketDepth > 0) angleBracketDepth--;
        } else if (ch === "{" && seenOpenParen && parenDepth === 0 && angleBracketDepth === 0) {
          bodyStart = j;
          bodyStartCol = segmentOffset + ci;
          break outer;
        } else if (ch === "=" && segment[ci + 1] === ">" && seenOpenParen && parenDepth === 0) {
          break outer;
        }
      }
    }

    if (bodyStart === -1) {
      i++;
      continue;
    }

    let depth = 0;
    let endLine = -1;
    for (let k = bodyStart; k < lines.length; k++) {
      const startCol = k === bodyStart ? bodyStartCol : 0;
      const curLine = lines[k] ?? "";
      for (let c = startCol; c < curLine.length; c++) {
        const ch = curLine[c];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            endLine = k;
            break;
          }
        }
      }
      if (endLine !== -1) break;
    }

    if (endLine !== -1) {
      regions.push({ name: methodName, startLine: i, endLine });
      i = endLine + 1;
    } else {
      i++;
    }
  }

  return regions;
}

export function checkMethodViolation(
  lines: string[],
  region: MethodRegion,
): { awaitLine: number; deleteLine: number } | null {
  let firstAwaitLine = -1;

  for (let i = region.startLine; i <= region.endLine; i++) {
    const line = lines[i] ?? "";
    if (isCommentLine(line)) continue;
    const stripped = stripInlineComment(line);

    if (firstAwaitLine === -1 && AWAIT_RE.test(stripped)) {
      firstAwaitLine = i;
    }

    if (firstAwaitLine !== -1 && SESSIONS_DELETE_RE.test(stripped)) {
      return { awaitLine: firstAwaitLine, deleteLine: i };
    }
  }

  return null;
}

const rule: CheckRule = {
  id: "session-teardown",
  kind: "check",
  scold:
    "this.sessions.delete must precede the first await — otherwise a concurrent teardown races on the map (TOCTOU)",
  guidance: [
    "move `this.sessions.delete(id)` above the first `await` in the method body",
    "between a yield and the delete, another microtask can call teardown and see the session still in the map",
    "JS is single-threaded: code before the first await runs atomically, so the early delete is the cheapest fix",
  ],
  documentation: "#1837 (incident), #1895 (fix)",
  check({ file, violated }) {
    if (!file.relPath.startsWith("packages/")) return;

    const lines = file.content.split("\n");
    for (const method of findAsyncMethods(lines)) {
      const v = checkMethodViolation(lines, method);
      if (v) {
        violated(
          v.deleteLine + 1,
          1,
          `async ${method.name}(): sessions.delete at line ${v.deleteLine + 1} follows first await at line ${v.awaitLine + 1}`,
        );
      }
    }
  },
};

export default rule;
