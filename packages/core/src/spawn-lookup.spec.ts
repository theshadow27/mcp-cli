import { describe, expect, test } from "bun:test";
import { isLookupFailure } from "./lookup-result";
import { runOrLookupFailure, runSyncOrLookupFailure } from "./spawn-lookup";

describe("runSyncOrLookupFailure", () => {
  test("returns stdout on success", () => {
    const result = runSyncOrLookupFailure("echo", ["hello"]);
    expect(isLookupFailure(result)).toBe(false);
    expect((result as string).trim()).toBe("hello");
  });

  test("returns LookupFailure on non-zero exit", () => {
    const result = runSyncOrLookupFailure("git", ["rev-parse", "--verify", "nonexistent-ref-abc123"]);
    expect(isLookupFailure(result)).toBe(true);
    if (isLookupFailure(result)) {
      expect(result.message).toContain("git rev-parse failed");
    }
  });

  test("returns LookupFailure when command does not exist", () => {
    const result = runSyncOrLookupFailure("__nonexistent_cmd_xyz__", ["arg"]);
    expect(isLookupFailure(result)).toBe(true);
  });
});

describe("runOrLookupFailure", () => {
  test("returns stdout on success", async () => {
    const result = await runOrLookupFailure("echo", ["hello"]);
    expect(isLookupFailure(result)).toBe(false);
    expect((result as string).trim()).toBe("hello");
  });

  test("returns LookupFailure on non-zero exit", async () => {
    const result = await runOrLookupFailure("git", ["rev-parse", "--verify", "nonexistent-ref-abc123"]);
    expect(isLookupFailure(result)).toBe(true);
    if (isLookupFailure(result)) {
      expect(result.message).toContain("git rev-parse failed");
    }
  });

  test("returns LookupFailure when command does not exist", async () => {
    const result = await runOrLookupFailure("__nonexistent_cmd_xyz__", ["arg"]);
    expect(isLookupFailure(result)).toBe(true);
  });
});
