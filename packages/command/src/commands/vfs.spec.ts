import { describe, expect, test } from "bun:test";
import type { VfsDeps } from "./vfs";
import { cmdVfs, resolveProvider } from "./vfs";

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function makeDeps(overrides: Partial<VfsDeps> = {}): VfsDeps {
  const fakeProvider = {} as ReturnType<VfsDeps["resolveProvider"]>;
  return {
    clone: async (opts) => ({
      path: opts.targetDir,
      pageCount: 5,
      scope: { key: opts.scope.key, cloudId: opts.scope.cloudId ?? "auto-123", resolved: {} },
    }),
    pull: async () => ({
      updated: 2,
      created: 1,
      deleted: 0,
      committed: true,
      incremental: true,
    }),
    push: async () => ({
      files: [],
      pushed: 1,
      created: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    }),
    exit: (code: number): never => {
      throw new ExitError(code);
    },
    resolveProvider: () => fakeProvider,
    resolveProviderFromCache: () => ({ provider: fakeProvider, providerName: "confluence" }),
    preflightCheck: async () => {},
    ...overrides,
  };
}

describe("cmdVfs", () => {
  describe("subcommand dispatch", () => {
    test("dispatches to clone", async () => {
      let called = false;
      const deps = makeDeps({
        clone: async () => {
          called = true;
          return { path: "/tmp/test", pageCount: 1, scope: { key: "FOO", cloudId: "c1", resolved: {} } };
        },
      });

      await cmdVfs(["clone", "confluence", "FOO"], undefined, deps);
      expect(called).toBe(true);
    });

    test("dispatches to pull", async () => {
      let called = false;
      const deps = makeDeps({
        pull: async () => {
          called = true;
          return { updated: 0, created: 0, deleted: 0, committed: false, incremental: true };
        },
      });

      await cmdVfs(["pull", "/tmp/repo"], undefined, deps);
      expect(called).toBe(true);
    });

    test("dispatches to push", async () => {
      let called = false;
      const deps = makeDeps({
        push: async () => {
          called = true;
          return { files: [], pushed: 0, created: 0, deleted: 0, conflicts: 0, errors: 0 };
        },
      });

      await cmdVfs(["push", "/tmp/repo"], undefined, deps);
      expect(called).toBe(true);
    });

    test("unknown subcommand exits non-zero", async () => {
      const deps = makeDeps();
      await expect(cmdVfs(["bogus"], undefined, deps)).rejects.toThrow("exit(1)");
    });

    test("no subcommand exits non-zero", async () => {
      const deps = makeDeps();
      await expect(cmdVfs([], undefined, deps)).rejects.toThrow("exit(1)");
    });
  });

  describe("clone flags", () => {
    test("--limit is parsed and forwarded", async () => {
      let capturedLimit: number | undefined;
      const deps = makeDeps({
        clone: async (opts) => {
          capturedLimit = opts.limit;
          return { path: opts.targetDir, pageCount: 3, scope: { key: "SP", cloudId: "c1", resolved: {} } };
        },
      });

      await cmdVfs(["clone", "confluence", "SP", "--limit", "10"], undefined, deps);
      expect(capturedLimit).toBe(10);
    });

    test("--cloud-id is parsed and forwarded", async () => {
      let capturedCloudId: string | undefined;
      const deps = makeDeps({
        clone: async (opts) => {
          capturedCloudId = opts.scope.cloudId;
          return {
            path: opts.targetDir,
            pageCount: 1,
            scope: { key: "SP", cloudId: opts.scope.cloudId ?? "", resolved: {} },
          };
        },
      });

      await cmdVfs(["clone", "confluence", "SP", "--cloud-id", "abc-123"], undefined, deps);
      expect(capturedCloudId).toBe("abc-123");
    });

    test("target dir is forwarded", async () => {
      let capturedDir: string | undefined;
      const deps = makeDeps({
        clone: async (opts) => {
          capturedDir = opts.targetDir;
          return { path: opts.targetDir, pageCount: 1, scope: { key: "SP", cloudId: "c1", resolved: {} } };
        },
      });

      await cmdVfs(["clone", "confluence", "SP", "/custom/dir"], undefined, deps);
      expect(capturedDir).toBe("/custom/dir");
    });

    test("missing args to clone exits non-zero", async () => {
      const deps = makeDeps();
      await expect(cmdVfs(["clone"], undefined, deps)).rejects.toThrow("exit(1)");
    });

    test("clone with only provider (no scope) exits non-zero", async () => {
      const deps = makeDeps();
      await expect(cmdVfs(["clone", "confluence"], undefined, deps)).rejects.toThrow("exit(1)");
    });

    test("resolveProvider is called with provider name", async () => {
      let capturedName: string | undefined;
      const fakeProvider = {} as ReturnType<VfsDeps["resolveProvider"]>;
      const deps = makeDeps({
        resolveProvider: (name) => {
          capturedName = name;
          return fakeProvider;
        },
      });

      await cmdVfs(["clone", "jira", "PROJ"], undefined, deps);
      expect(capturedName).toBe("jira");
    });
  });

  describe("pull flags", () => {
    test("--full is forwarded", async () => {
      let capturedFull: boolean | undefined;
      const deps = makeDeps({
        pull: async (opts) => {
          capturedFull = opts.full;
          return { updated: 0, created: 0, deleted: 0, committed: false, incremental: false };
        },
      });

      await cmdVfs(["pull", "--full", "/tmp/repo"], undefined, deps);
      expect(capturedFull).toBe(true);
    });

    test("resolveProviderFromCache is called with repo dir", async () => {
      let capturedDir: string | undefined;
      const fakeProvider = {} as ReturnType<VfsDeps["resolveProvider"]>;
      const deps = makeDeps({
        resolveProviderFromCache: (dir) => {
          capturedDir = dir;
          return { provider: fakeProvider, providerName: "confluence" };
        },
      });

      await cmdVfs(["pull", "/my/repo"], undefined, deps);
      expect(capturedDir).toBe("/my/repo");
    });
  });

  describe("push flags", () => {
    test("--dry-run from opts is forwarded", async () => {
      let capturedDryRun: boolean | undefined;
      const deps = makeDeps({
        push: async (opts) => {
          capturedDryRun = opts.dryRun;
          return { files: [], pushed: 0, created: 0, deleted: 0, conflicts: 0, errors: 0 };
        },
      });

      await cmdVfs(["push", "/tmp/repo"], { dryRun: true }, deps);
      expect(capturedDryRun).toBe(true);
    });

    test("--dry-run in args is forwarded", async () => {
      let capturedDryRun: boolean | undefined;
      const deps = makeDeps({
        push: async (opts) => {
          capturedDryRun = opts.dryRun;
          return { files: [], pushed: 0, created: 0, deleted: 0, conflicts: 0, errors: 0 };
        },
      });

      await cmdVfs(["push", "--dry-run", "/tmp/repo"], undefined, deps);
      expect(capturedDryRun).toBe(true);
    });

    test("--create flag is forwarded", async () => {
      let capturedCreate: boolean | undefined;
      const deps = makeDeps({
        push: async (opts) => {
          capturedCreate = opts.create;
          return { files: [], pushed: 0, created: 0, deleted: 0, conflicts: 0, errors: 0 };
        },
      });

      await cmdVfs(["push", "--create", "/tmp/repo"], undefined, deps);
      expect(capturedCreate).toBe(true);
    });

    test("exits non-zero on conflicts", async () => {
      const deps = makeDeps({
        push: async () => ({
          files: [],
          pushed: 0,
          created: 0,
          deleted: 0,
          conflicts: 1,
          errors: 0,
        }),
      });

      await expect(cmdVfs(["push", "/tmp/repo"], undefined, deps)).rejects.toThrow("exit(1)");
    });

    test("exits non-zero on errors", async () => {
      const deps = makeDeps({
        push: async () => ({
          files: [],
          pushed: 0,
          created: 0,
          deleted: 0,
          conflicts: 0,
          errors: 2,
        }),
      });

      await expect(cmdVfs(["push", "/tmp/repo"], undefined, deps)).rejects.toThrow("exit(1)");
    });
  });
});

describe("resolveProvider", () => {
  test("returns a confluence provider", () => {
    const provider = resolveProvider("confluence");
    expect(provider).toBeDefined();
  });

  test("returns an asana provider", () => {
    const provider = resolveProvider("asana");
    expect(provider).toBeDefined();
  });

  test("returns a jira provider", () => {
    const provider = resolveProvider("jira");
    expect(provider).toBeDefined();
  });

  test("exits on unknown provider", () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    try {
      resolveProvider("unknown");
      expect(exitCode).toBe(1);
    } finally {
      process.exit = origExit;
    }
  });
});
