#!/usr/bin/env bun
/**
 * Lint rule: this.sessions.delete must precede the first await in async methods.
 *
 * Background: JS is single-threaded but async. In an async method, code before
 * the first `await` runs atomically. Once an `await` yields, other microtasks
 * can run. If a method removes a session from the map only after an `await`,
 * a concurrent teardown call that starts during that yield will still see the
 * session in the map — a TOCTOU race that can cause double-cleanup or orphaned
 * worktrees (see #1837, fixed in #1895).
 *
 * The invariant: this.sessions.delete must appear before the first `await`
 * in any async method that calls it, so any concurrent call starting after
 * that await finds the map already updated.
 *
 * Usage:  bun scripts/check-session-teardown.ts
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — violations found
 */

import { Glob } from "bun";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

interface Violation {
  file: string;
  methodLine: number; // 1-indexed
  methodName: string;
  awaitLine: number; // 1-indexed, first await before the delete
  deleteLine: number; // 1-indexed, the out-of-order delete
}

// Matches async method/function signatures (not anonymous arrow functions).
// Handles optional access modifiers before async.
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
  startLine: number; // 0-indexed
  endLine: number; // 0-indexed
}

/**
 * Find all async method/function regions in the source lines.
 * Each region covers from the signature line to the closing brace.
 * Exported for testing.
 */
export function findAsyncMethods(lines: string[]): MethodRegion[] {
  const regions: MethodRegion[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

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

    // Scan forward from the match position to find the opening '{' of the body.
    // Track paren depth to skip past the parameter list and return type annotation.
    // Track angle-bracket depth to skip '{' inside generic return types like
    // Promise<{ result: string }> — the '{' inside '<>' is not the body start.
    let bodyStart = -1;
    let bodyStartCol = -1; // column of the '{' within lines[bodyStart]
    let parenDepth = 0;
    let seenOpenParen = false;
    let angleBracketDepth = 0;

    outer: for (let j = i; j < Math.min(i + 20, lines.length); j++) {
      // On the first line, start scanning from the match position to avoid
      // false-positive '{' in code before the matched signature.
      const segment = j === i ? line.slice(m.index) : lines[j];
      // segmentOffset: how many characters to add to ci to get the column in lines[j].
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
          // Concise arrow function without braces — skip.
          break outer;
        }
      }
    }

    if (bodyStart === -1) {
      i++;
      continue;
    }

    // Count braces from the body-start '{' to find the matching closing brace.
    // Start at bodyStartCol (not line start) so that return-type '}' characters
    // that appear earlier on the same line as the body '{' are not counted.
    let depth = 0;
    let endLine = -1;
    for (let k = bodyStart; k < lines.length; k++) {
      const startCol = k === bodyStart ? bodyStartCol : 0;
      for (let c = startCol; c < lines[k].length; c++) {
        const ch = lines[k][c];
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
      // Skip past the method body — nested async functions are checked
      // as part of this region, not as independent top-level regions.
      i = endLine + 1;
    } else {
      i++;
    }
  }

  return regions;
}

/**
 * Check a method region for the TOCTOU violation: sessions.delete after await.
 * Returns the 0-indexed line numbers of the first await and the violating delete,
 * or null if there is no violation.
 * Exported for testing.
 */
export function checkMethodViolation(
  lines: string[],
  region: MethodRegion,
): { awaitLine: number; deleteLine: number } | null {
  let firstAwaitLine = -1;

  for (let i = region.startLine; i <= region.endLine; i++) {
    const line = lines[i];
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

async function scanDir(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.ts");

  for await (const relPath of glob.scan({ cwd: dir, absolute: false })) {
    if (relPath.endsWith(".d.ts") || relPath.includes("node_modules")) continue;

    const absPath = `${dir}${relPath}`;
    const content = await Bun.file(absPath).text();
    const lines = content.split("\n");

    for (const method of findAsyncMethods(lines)) {
      const v = checkMethodViolation(lines, method);
      if (v) {
        violations.push({
          file: absPath,
          methodLine: method.startLine + 1,
          methodName: method.name,
          awaitLine: v.awaitLine + 1,
          deleteLine: v.deleteLine + 1,
        });
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const violations = await scanDir(PACKAGES_DIR);

  if (violations.length === 0) {
    process.stderr.write("No session-teardown TOCTOU violations found.\n");
    process.exit(0);
  }

  process.stderr.write(`\n  Session teardown TOCTOU: ${violations.length} violation(s) found\n\n`);
  process.stderr.write("  this.sessions.delete must appear before the first await in async methods.\n");
  process.stderr.write("  After an await, concurrent callers can race to see the session in the map.\n\n");

  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.methodLine} — async ${v.methodName}()\n`);
    process.stderr.write(`    first await at line ${v.awaitLine}\n`);
    process.stderr.write(`    sessions.delete at line ${v.deleteLine} (must come first)\n\n`);
  }

  process.stderr.write("  Fix: move this.sessions.delete before the first await.\n\n");

  process.exit(1);
}

if (import.meta.main) {
  main();
}
