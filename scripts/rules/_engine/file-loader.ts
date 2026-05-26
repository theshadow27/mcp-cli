/**
 * File loader for the rule engine.
 *
 * mcp-cli is a layered Bun workspace — a one-line edit to
 * `packages/core/src/model.ts` fans out through the `@mcp-cli/core`
 * barrel to 165+ test files. The loader stays simple on purpose: glob
 * `packages/`, `scripts/`, `test/` for *.ts (excluding .d.ts and
 * node_modules), read each into memory, attach a few quick-derived
 * flags (`isTest`, `pkg`) and return a Map keyed by absolute path.
 * Cross-package import edges are not tracked here; `bun test --changed`
 * owns the authoritative module graph for diff-aware test selection.
 *
 * Rules that need richer metadata (parsed imports/exports) can attach
 * their own per-rule cache. We intentionally don't pre-parse ASTs across
 * the whole tree — most rules don't need it, and per-rule lazy parsing
 * keeps cold-run time predictable.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Glob } from "bun";

export interface FileMeta {
  /** Absolute path on disk. */
  path: string;
  /** Repo-relative path. Used in reports. */
  relPath: string;
  /** File contents, UTF-8. */
  content: string;
  /** Workspace prefix: "packages/<name>" | "scripts" | "test" | "". */
  pkg: string;
  /** True for *.spec.ts / *.test.ts (and .tsx variants). */
  isTest: boolean;
}

const TEST_RE = /\.(spec|test)\.tsx?$/;

export function isTestFile(path: string): boolean {
  return TEST_RE.test(path);
}

export function getPackageForPath(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  const parts = rel.split("/");
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === "scripts" || parts[0] === "test") return parts[0];
  return "";
}

export interface LoadOptions {
  repoRoot: string;
  /** Roots to scan, relative to repoRoot. Default: packages/, scripts/, test/. */
  roots?: string[];
  /** Substring filter on relative path. Empty = no filter. */
  filter?: string;
}

export async function loadFiles({ repoRoot, roots, filter }: LoadOptions): Promise<Map<string, FileMeta>> {
  const scanRoots = roots ?? ["packages", "scripts", "test"];
  const out = new Map<string, FileMeta>();
  for (const root of scanRoots) {
    const cwd = join(repoRoot, root);
    const glob = new Glob("**/*.{ts,tsx}");
    for await (const rel of glob.scan({ cwd, absolute: false })) {
      if (rel.endsWith(".d.ts")) continue;
      if (rel.includes("node_modules")) continue;
      // Fixtures intentionally contain the shapes rules detect; they're
      // exercised through the fixture-loader path, not the production scan.
      if (rel.includes("rules/fixtures/") || rel.endsWith(".fixture.ts") || rel.endsWith(".fixture.tsx")) continue;
      // Rule definitions document the very patterns they detect (regex
      // literals, scold strings, example snippets in JSDoc). Scanning
      // them means rules silently flag themselves. Engine internals
      // (`scripts/rules/_engine/`) stay in scope — they're product code.
      if (rel.endsWith(".rule.ts") || rel.endsWith(".rule.tsx")) continue;
      const abs = join(cwd, rel);
      const repoRel = relative(repoRoot, abs);
      if (filter && !repoRel.includes(filter)) continue;
      const content = await readFile(abs, "utf8");
      out.set(abs, {
        path: abs,
        relPath: repoRel,
        content,
        pkg: getPackageForPath(repoRoot, abs),
        isTest: isTestFile(abs),
      });
    }
  }
  return out;
}
