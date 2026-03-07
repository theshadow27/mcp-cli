import { describe, expect, test } from "bun:test";
import { defaultSpawn } from "./spawn";

describe("defaultSpawn", () => {
  test("succeeds on exit 0", async () => {
    await expect(defaultSpawn(["true"], "test")).resolves.toBeUndefined();
  });

  test("throws on non-zero exit", async () => {
    await expect(defaultSpawn(["false"], "MyTerm")).rejects.toThrow(/MyTerm: command failed \(exit 1\)/);
  });

  test("includes stderr in error message", async () => {
    await expect(defaultSpawn(["sh", "-c", "echo oops >&2; exit 1"], "TestLabel")).rejects.toThrow(/oops/);
  });
});
