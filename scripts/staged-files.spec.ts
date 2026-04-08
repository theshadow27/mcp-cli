/**
 * Tests for staged-files.ts — run with: bun test scripts/staged-files.spec.ts
 * (Not auto-discovered by `bun test` due to bunfig.toml pathIgnorePatterns)
 */
import { describe, expect, it } from "bun:test";
import { shouldSkipRun2 } from "./staged-files";

describe("shouldSkipRun2", () => {
  it("returns false when no files are staged (safety default)", () => {
    expect(shouldSkipRun2([])).toBe(false);
  });

  it("returns true when only command package files are staged", () => {
    expect(shouldSkipRun2(["packages/command/src/commands/call.ts"])).toBe(true);
  });

  it("returns true when only control package files are staged", () => {
    expect(shouldSkipRun2(["packages/control/src/app.tsx"])).toBe(true);
  });

  it("returns false when daemon files are staged", () => {
    expect(shouldSkipRun2(["packages/daemon/src/ipc-server.ts"])).toBe(false);
  });

  it("returns false when core files are staged", () => {
    expect(shouldSkipRun2(["packages/core/src/ipc.ts"])).toBe(false);
  });

  it("returns false when test/ files are staged", () => {
    expect(shouldSkipRun2(["test/daemon-integration.spec.ts"])).toBe(false);
  });

  it("returns false when check-coverage.ts itself is staged", () => {
    expect(shouldSkipRun2(["scripts/check-coverage.ts"])).toBe(false);
  });

  it("returns false when a mix includes daemon files", () => {
    expect(shouldSkipRun2(["packages/command/src/commands/ls.ts", "packages/daemon/src/server-pool.ts"])).toBe(false);
  });

  it("returns true when only non-trigger files are staged", () => {
    expect(
      shouldSkipRun2([
        "packages/command/src/commands/call.ts",
        "packages/command/src/output.ts",
        ".git-hooks/pre-commit",
      ]),
    ).toBe(true);
  });
});
