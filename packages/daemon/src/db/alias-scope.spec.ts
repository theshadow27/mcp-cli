/**
 * Tests for the aliases.scope column introduced in #1289.
 *
 * Verifies:
 *  - legacy NULL rows round-trip unchanged (regression guard)
 *  - global scope is persisted and round-trips
 *  - path scope is persisted and round-trips
 *  - scope survives upsert when the same column is rewritten explicitly
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "./state";

describe("aliases.scope column", () => {
  let tmpDir: string;
  let db: StateDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-alias-scope-"));
    db = new StateDb(join(tmpDir, "state.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("legacy save (no scope) round-trips as null", () => {
    db.saveAlias("legacy", "/tmp/legacy.ts", "desc");
    const row = db.getAlias("legacy");
    expect(row?.scope).toBeNull();
    const list = db.listAliases();
    expect(list.find((a) => a.name === "legacy")?.scope).toBeNull();
  });

  test("global scope is persisted", () => {
    db.saveAlias("g", "/tmp/g.ts", "desc", "freeform", undefined, undefined, undefined, undefined, undefined, "global");
    expect(db.getAlias("g")?.scope).toBe("global");
  });

  test("path scope is persisted", () => {
    db.saveAlias(
      "p",
      "/tmp/p.ts",
      "desc",
      "freeform",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "/workspace/repo",
    );
    expect(db.getAlias("p")?.scope).toBe("/workspace/repo");
  });

  test("explicit null scope clears existing scope on upsert", () => {
    db.saveAlias("x", "/tmp/x.ts", "d", "freeform", undefined, undefined, undefined, undefined, undefined, "global");
    expect(db.getAlias("x")?.scope).toBe("global");
    db.saveAlias("x", "/tmp/x.ts", "d", "freeform", undefined, undefined, undefined, undefined, undefined, null);
    expect(db.getAlias("x")?.scope).toBeNull();
  });
});
