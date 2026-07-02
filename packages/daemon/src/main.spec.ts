import { describe, expect, test } from "bun:test";
import { resolveWorkerEntry } from "./main";

describe("resolveWorkerEntry", () => {
  test("returns canonical entry for ./alias-executor.ts", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./alias-executor.ts"])).toBe("alias-executor.ts");
  });

  test("returns canonical entry for absolute path ending in alias-executor.ts (dev)", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "/some/dir/alias-executor.ts"])).toBe("alias-executor.ts");
  });

  test("returns canonical entry for resolved embedded .js path (compiled, #2821)", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "/$bunfs/root/packages/daemon/src/alias-executor.js"])).toBe(
      "alias-executor.ts",
    );
  });

  test("returns canonical entry for ./alias-executor.js", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./alias-executor.js"])).toBe("alias-executor.ts");
  });

  test("returns undefined for normal daemon startup (no args)", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd"])).toBeUndefined();
  });

  test("returns undefined for empty argv", () => {
    expect(resolveWorkerEntry([])).toBeUndefined();
  });

  test("returns undefined for unrecognized worker path", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./not-a-worker.ts"])).toBeUndefined();
  });
});
