#!/usr/bin/env bun
/**
 * Validates `agent-grid/versions.yaml` against its Zod schema.
 * Called as an am-i-done step; also usable standalone.
 *
 * Exit 0 on valid, 1 on validation errors, 2 on file-read errors.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateVersionsGrid } from "../agent-grid/versions-schema";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GRID_DIR = resolve(REPO_ROOT, "agent-grid");
const VERSIONS_PATH = resolve(GRID_DIR, "versions.yaml");

function main(): void {
  let text: string;
  try {
    text = readFileSync(VERSIONS_PATH, "utf-8");
  } catch (err) {
    process.stderr.write(`error: cannot read ${VERSIONS_PATH}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    process.stderr.write(`error: invalid YAML in ${VERSIONS_PATH}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const result = validateVersionsGrid(raw, GRID_DIR);

  if (result.ok) {
    const grid = result.grid as NonNullable<typeof result.grid>;
    const providerCount = grid.providers.length;
    const versionCount = grid.providers.reduce((n, p) => n + p.versions.length, 0);
    process.stderr.write(
      `agent-grid: ${providerCount} provider${providerCount === 1 ? "" : "s"}, ${versionCount} version entr${versionCount === 1 ? "y" : "ies"} — valid\n`,
    );
    process.exit(0);
  }

  process.stderr.write("agent-grid/versions.yaml validation failed:\n");
  for (const issue of result.issues) {
    process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
  }
  process.exit(1);
}

main();
