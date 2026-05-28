#!/usr/bin/env bun
/**
 * check-stale-todos — flag dotw-todo comments referencing closed GitHub issues.
 *
 * Called by `am-i-done --ci` only: shells out to `gh` per unique issue number
 * and is too slow for pre-commit. Reads from the same file tree as the rule
 * engine (packages/, scripts/, test/) with the same exclusions (no fixtures,
 * no .rule.ts, no .d.ts, no node_modules).
 *
 * Exit 0: all referenced issues are open (or none found).
 * Exit 1: at least one dotw-todo references a closed issue.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

const TODO_FULL_RE = /\/\/\s*dotw-todo\s+([\w-]+)\s*:\s*(.+)$/;
const ISSUE_NUM_RE = /#(\d+)/g;
const STRING_LITERAL_QUOTES = new Set(['"', "'", "`"]);

export interface TodoRef {
  file: string;
  line: number;
  issueNumbers: number[];
  snippet: string;
}

/**
 * Extract all dotw-todo issue references from a single file's content.
 * Applies the same string-literal guard as the dotw-todo-needs-issue rule:
 * a `//` immediately preceded by `"`, `'`, or `` ` `` is prose, not a
 * suppression comment, and is skipped.
 */
export function extractTodoRefs(content: string, relPath: string): TodoRef[] {
  const refs: TodoRef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = TODO_FULL_RE.exec(line);
    if (!m || !m[2]) continue;
    const matchIdx = line.indexOf(m[0]);
    const preceding = matchIdx > 0 ? line[matchIdx - 1] : undefined;
    if (preceding !== undefined && STRING_LITERAL_QUOTES.has(preceding)) continue;
    const desc = m[2];
    const issueNumbers: number[] = [];
    ISSUE_NUM_RE.lastIndex = 0;
    for (let im = ISSUE_NUM_RE.exec(desc); im !== null; im = ISSUE_NUM_RE.exec(desc)) {
      issueNumbers.push(Number.parseInt(im[1] as string, 10));
    }
    if (issueNumbers.length === 0) continue;
    refs.push({ file: relPath, line: i + 1, issueNumbers, snippet: line.trim() });
  }
  return refs;
}

async function scanFiles(repoRoot: string): Promise<TodoRef[]> {
  const roots = ["packages", "scripts", "test"];
  const all: TodoRef[] = [];
  for (const root of roots) {
    const cwd = join(repoRoot, root);
    const glob = new Glob("**/*.{ts,tsx}");
    for await (const rel of glob.scan({ cwd, absolute: false })) {
      if (rel.endsWith(".d.ts")) continue;
      if (rel.includes("node_modules")) continue;
      if (rel.includes("rules/fixtures/") || rel.endsWith(".fixture.ts") || rel.endsWith(".fixture.tsx")) continue;
      if (rel.endsWith(".rule.ts") || rel.endsWith(".rule.tsx")) continue;
      const abs = join(cwd, rel);
      const content = await readFile(abs, "utf8");
      all.push(...extractTodoRefs(content, relative(repoRoot, abs)));
    }
  }
  return all;
}

function fetchIssueState(issueNumber: number): string | null {
  const result = Bun.spawnSync(["gh", "issue", "view", String(issueNumber), "--json", "state", "--jq", ".state"]);
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
}

async function main(): Promise<void> {
  const refs = await scanFiles(REPO_ROOT);
  if (refs.length === 0) {
    process.stdout.write("✓ no dotw-todo issue references found\n");
    return;
  }

  const uniqueNumbers = new Set<number>();
  for (const ref of refs) {
    for (const n of ref.issueNumbers) uniqueNumbers.add(n);
  }

  const closedIssues = new Set<number>();
  const unreachable = new Set<number>();
  for (const n of uniqueNumbers) {
    const state = fetchIssueState(n);
    if (state === null) unreachable.add(n);
    else if (state === "CLOSED") closedIssues.add(n);
  }

  if (unreachable.size > 0) {
    process.stderr.write(
      `⚠ could not fetch state for issue(s): ${[...unreachable].map((n) => `#${n}`).join(", ")} — skipped\n`,
    );
  }

  const stale = refs.filter((r) => r.issueNumbers.some((n) => closedIssues.has(n)));
  if (stale.length === 0) {
    process.stdout.write(
      `✓ ${refs.length} dotw-todo ref${refs.length === 1 ? "" : "s"} checked — all referenced issues open\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ ${stale.length} dotw-todo comment${stale.length === 1 ? "" : "s"} reference closed issue${stale.length === 1 ? "" : "s"}:\n\n`,
  );
  for (const ref of stale) {
    const closed = ref.issueNumbers.filter((n) => closedIssues.has(n));
    process.stderr.write(`  ${ref.file}:${ref.line}  ${closed.map((n) => `#${n} (CLOSED)`).join(", ")}\n`);
    process.stderr.write(`    ${ref.snippet}\n\n`);
  }
  process.stderr.write(
    "fix: remove the violation (and its dotw-todo), or reopen/file a successor issue and update the reference\n",
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
