import { describe, expect, test } from "bun:test";
import { resolveWorkerEntry } from "./main";

describe("resolveWorkerEntry", () => {
  test("returns module path for ./alias-executor.ts", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./alias-executor.ts"])).toBe("./alias-executor.ts");
  });

  test("returns module path for absolute path ending in alias-executor.ts", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "/some/dir/alias-executor.ts"])).toBe("./alias-executor.ts");
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
