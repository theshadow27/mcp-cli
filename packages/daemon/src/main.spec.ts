import { describe, expect, test } from "bun:test";
import { resolveWorkerEntry } from "./main";

const WORKER_ENV = { MCPD_WORKER: "1" };

describe("resolveWorkerEntry", () => {
  test("returns canonical entry for ./alias-executor.ts", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./alias-executor.ts"], WORKER_ENV)).toBe("alias-executor.ts");
  });

  test("returns canonical entry for absolute path ending in alias-executor.ts (dev)", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "/some/dir/alias-executor.ts"], WORKER_ENV)).toBe("alias-executor.ts");
  });

  test("returns canonical entry for resolved embedded .js path (compiled, #2821)", () => {
    expect(
      resolveWorkerEntry(["/path/to/mcpd", "/$bunfs/root/packages/daemon/src/alias-executor.js"], WORKER_ENV),
    ).toBe("alias-executor.ts");
  });

  test("returns canonical entry for ./alias-executor.js", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./alias-executor.js"], WORKER_ENV)).toBe("alias-executor.ts");
  });

  test("returns undefined for normal daemon startup (no args)", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd"], WORKER_ENV)).toBeUndefined();
  });

  test("returns undefined for empty argv", () => {
    expect(resolveWorkerEntry([], WORKER_ENV)).toBeUndefined();
  });

  test("returns undefined for unrecognized worker path", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "./not-a-worker.ts"], WORKER_ENV)).toBeUndefined();
  });

  test("returns undefined for matching argv without the MCPD_WORKER sentinel (#2835)", () => {
    expect(resolveWorkerEntry(["/path/to/mcpd", "/any/path/alias-executor.js"], {})).toBeUndefined();
    expect(resolveWorkerEntry(["/path/to/mcpd", "./alias-executor.ts"], {})).toBeUndefined();
  });
});
