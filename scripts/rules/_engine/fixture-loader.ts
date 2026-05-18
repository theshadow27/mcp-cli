/**
 * Fixture loader for rule tests.
 *
 * A fixture is a real .ts file at `scripts/rules/fixtures/<rule-id>__<scenario>.fixture.ts`
 * carrying a JSDoc frontmatter block:
 *
 *     /\*\*
 *      * @rule shell-injection
 *      * @expect 2
 *      * @path packages/command/src/example.ts
 *      *\/
 *
 * Convention:
 *   - The file name's leading segment (before `__`) MUST match the @rule tag.
 *   - @expect is the exact violation count the rule should find.
 *   - @path is the synthetic path the rule sees (controls package/test gating).
 *
 * The frontmatter and any other JSDoc blocks in the fixture body are
 * replaced with whitespace at parse time, preserving line numbers. This
 * means rule line/column reports stay aligned with the on-disk fixture
 * AND prose tokens in explanations don't trigger false positives for
 * pattern-based rules.
 *
 * Why fixtures over inline strings: rule logic that depends on JSDoc
 * stripping, multi-line contexts, or realistic-shape imports breaks
 * silently with single-line `expect(...)` assertions. A fixture is the
 * shape the rule will actually see.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";

import type { FileMeta } from "./file-loader";

export interface FixtureFrontmatter {
  rule: string;
  expect: number;
  path: string;
}

export interface Fixture {
  fileName: string;
  frontmatter: FixtureFrontmatter;
  /** The fixture body with JSDoc blocks blanked (lines preserved). */
  body: string;
  /** A FileMeta shaped exactly like loadFiles() would produce. */
  fileMeta: FileMeta;
}

const FRONTMATTER_BLOCK = /\/\*\*([\s\S]*?)\*\//;
const TAG_RULE = /@rule\s+(\S+)/;
const TAG_EXPECT = /@expect\s+(\S+)/;
const TAG_PATH = /@path\s+(\S+)/;

export function parseFrontmatter(fileName: string, content: string): FixtureFrontmatter {
  const block = FRONTMATTER_BLOCK.exec(content)?.[1];
  if (!block) throw new Error(`fixture ${fileName}: missing JSDoc frontmatter block`);
  const rule = TAG_RULE.exec(block)?.[1];
  const expectRaw = TAG_EXPECT.exec(block)?.[1];
  const path = TAG_PATH.exec(block)?.[1];
  if (!rule) throw new Error(`fixture ${fileName}: missing @rule`);
  if (!expectRaw || !/^\d+$/.test(expectRaw)) {
    throw new Error(`fixture ${fileName}: @expect must be a non-negative integer, got ${expectRaw ?? "<none>"}`);
  }
  if (!path) throw new Error(`fixture ${fileName}: missing @path`);

  // Convention: file name prefix matches the @rule tag.
  const prefix = (fileName.split("__")[0] ?? "").replace(/\.fixture\.tsx?$/, "");
  if (prefix !== rule) {
    throw new Error(`fixture ${fileName}: file name prefix '${prefix}' must match @rule '${rule}'`);
  }
  return { rule, expect: Number.parseInt(expectRaw, 10), path };
}

/**
 * Replace every `/** ... *\/` JSDoc block with whitespace, preserving
 * newlines so violation line numbers stay aligned to the on-disk
 * fixture's source.
 */
export function blankJsDocBlocks(content: string): string {
  return content.replace(/\/\*\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

export async function loadFixture(absPath: string, fileName: string): Promise<Fixture> {
  const raw = await readFile(absPath, "utf8");
  const frontmatter = parseFrontmatter(fileName, raw);
  const body = blankJsDocBlocks(raw);
  const fileMeta: FileMeta = {
    path: frontmatter.path,
    relPath: frontmatter.path,
    content: body,
    pkg: frontmatter.path.split("/").slice(0, 2).join("/"),
    isTest: /\.(spec|test)\.tsx?$/.test(frontmatter.path),
  };
  return { fileName, frontmatter, body, fileMeta };
}

export async function loadAllFixtures(fixturesDir: string): Promise<Fixture[]> {
  const out: Fixture[] = [];
  const glob = new Glob("**/*.fixture.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: fixturesDir, absolute: false })) {
    out.push(await loadFixture(join(fixturesDir, rel), rel));
  }
  return out;
}
