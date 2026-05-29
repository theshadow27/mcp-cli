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
const VERSIONS_PATH = resolve(REPO_ROOT, "agent-grid", "versions.yaml");

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

  const result = validateVersionsGrid(raw);

  const warnings = result.issues.filter((i) => i.severity === "warn");
  const errors = result.issues.filter((i) => i.severity === "error");

  for (const w of warnings) {
    process.stderr.write(`  warn: ${w.path}: ${w.message}\n`);
  }

  if (result.ok) {
    const { grid } = result;
    const providerCount = grid.providers.length;
    const versionCount = grid.providers.reduce((n, p) => n + p.versions.length, 0);
    process.stdout.write(
      `agent-grid: ${providerCount} provider${providerCount === 1 ? "" : "s"}, ${versionCount} version entr${versionCount === 1 ? "y" : "ies"} — valid\n`,
    );
    process.exit(0);
  }

  process.stderr.write("agent-grid/versions.yaml validation failed:\n");
  for (const issue of errors) {
    process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
  }
  process.exit(1);
}

main();
