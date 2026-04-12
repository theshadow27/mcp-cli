import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloneCache, VfsError } from "@mcp-cli/clone";
import type { VfsDeps } from "./vfs";
import { cmdVfs, makeToolCaller, onRetry, preflightCheck, resolveProvider, resolveProviderFromCache } from "./vfs";

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
      stubCount: 0,
      scope: { key: opts.scope.key, cloudId: opts.scope.cloudId ?? "auto-123", resolved: {} },
    }),
    pull: async () => ({
      updated: 2,
      created: 1,
      deleted: 0,
      committed: true,
      incremental: true,
      deepened: 0,
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
          return { path: "/tmp/test", pageCount: 1, stubCount: 0, scope: { key: "FOO", cloudId: "c1", resolved: {} } };
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
          return { updated: 0, created: 0, deleted: 0, deepened: 0, committed: false, incremental: true };
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
          return {
            path: opts.targetDir,
            pageCount: 3,
            stubCount: 0,
            scope: { key: "SP", cloudId: "c1", resolved: {} },
          };
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
            stubCount: 0,
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
          return {
            path: opts.targetDir,
            pageCount: 1,
            stubCount: 0,
            scope: { key: "SP", cloudId: "c1", resolved: {} },
          };
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

    test("--depth is parsed and forwarded", async () => {
      let capturedDepth: number | undefined;
      const deps = makeDeps({
        clone: async (opts) => {
          capturedDepth = opts.depth;
          return {
            path: opts.targetDir,
            pageCount: 3,
            stubCount: 2,
            scope: { key: "SP", cloudId: "c1", resolved: {} },
          };
        },
      });

      await cmdVfs(["clone", "confluence", "SP", "--depth", "2"], undefined, deps);
      expect(capturedDepth).toBe(2);
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
          return { updated: 0, created: 0, deleted: 0, deepened: 0, committed: false, incremental: false };
        },
      });

      await cmdVfs(["pull", "--full", "/tmp/repo"], undefined, deps);
      expect(capturedFull).toBe(true);
    });

    test("--depth is parsed and forwarded", async () => {
      let capturedDepth: number | undefined;
      const deps = makeDeps({
        pull: async (opts) => {
          capturedDepth = opts.depth;
          return { updated: 0, created: 0, deleted: 0, deepened: 0, committed: false, incremental: false };
        },
      });

      await cmdVfs(["pull", "--depth", "3", "/tmp/repo"], undefined, deps);
      expect(capturedDepth).toBe(3);
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

  describe("deprecation warnings", () => {
    function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
      const orig = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        return true;
      }) as typeof process.stderr.write;
      return fn()
        .then((result) => ({ result, stderr: captured }))
        .finally(() => {
          process.stderr.write = orig;
        });
    }

    test("vfs pull warns that it is deprecated", async () => {
      const deps = makeDeps();
      const { stderr } = await captureStderr(() => cmdVfs(["pull", "/tmp/repo"], undefined, deps));
      expect(stderr).toContain('"mcx vfs pull" is deprecated');
      expect(stderr).toContain('Use "git pull" instead');
    });

    test("vfs push warns that it is deprecated", async () => {
      const deps = makeDeps();
      const { stderr } = await captureStderr(() => cmdVfs(["push", "/tmp/repo"], undefined, deps));
      expect(stderr).toContain('"mcx vfs push" is deprecated');
      expect(stderr).toContain('Use "git push" instead');
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

  test("returns a github-issues provider", () => {
    const provider = resolveProvider("github-issues");
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

describe("VfsError handling in cmdVfs", () => {
  test("vfs clone catches VfsError and exits", async () => {
    const deps = makeDeps({
      clone: async () => {
        throw new VfsError("auth", "bad token");
      },
    });
    await expect(cmdVfs(["clone", "confluence", "SP"], undefined, deps)).rejects.toThrow("exit(1)");
  });

  test("vfs clone rethrows non-VfsError", async () => {
    const deps = makeDeps({
      clone: async () => {
        throw new Error("unexpected");
      },
    });
    await expect(cmdVfs(["clone", "confluence", "SP"], undefined, deps)).rejects.toThrow("unexpected");
  });

  test("vfs pull catches VfsError and exits", async () => {
    const deps = makeDeps({
      pull: async () => {
        throw new VfsError("rate_limit", "429");
      },
    });
    await expect(cmdVfs(["pull", "/tmp/repo"], undefined, deps)).rejects.toThrow("exit(1)");
  });

  test("vfs pull rethrows non-VfsError", async () => {
    const deps = makeDeps({
      pull: async () => {
        throw new Error("boom");
      },
    });
    await expect(cmdVfs(["pull", "/tmp/repo"], undefined, deps)).rejects.toThrow("boom");
  });

  test("vfs push catches VfsError and exits", async () => {
    const deps = makeDeps({
      push: async () => {
        throw new VfsError("conflict", "etag mismatch");
      },
    });
    await expect(cmdVfs(["push", "/tmp/repo"], undefined, deps)).rejects.toThrow("exit(1)");
  });

  test("vfs push rethrows non-VfsError", async () => {
    const deps = makeDeps({
      push: async () => {
        throw new Error("network partition");
      },
    });
    await expect(cmdVfs(["push", "/tmp/repo"], undefined, deps)).rejects.toThrow("network partition");
  });
});

describe("makeToolCaller", () => {
  test("forwards server/tool/args to ipc with callTool method", async () => {
    const calls: Array<{ method: string; params: unknown; opts?: unknown }> = [];
    const fakeIpc = (async (method: string, params: unknown, opts?: unknown) => {
      calls.push({ method, params, opts });
      return { ok: true };
    }) as unknown as Parameters<typeof makeToolCaller>[0];

    const caller = makeToolCaller(fakeIpc);
    const result = await caller("atlassian", "searchSpaces", { q: "FOO" }, undefined);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("callTool");
    expect(calls[0].params).toEqual({ server: "atlassian", tool: "searchSpaces", arguments: { q: "FOO" } });
    expect(calls[0].opts).toBeUndefined();
  });

  test("passes timeoutMs through as opts when provided", async () => {
    let capturedOpts: unknown;
    const fakeIpc = (async (_method: string, _params: unknown, opts?: unknown) => {
      capturedOpts = opts;
      return undefined;
    }) as unknown as Parameters<typeof makeToolCaller>[0];

    const caller = makeToolCaller(fakeIpc);
    await caller("asana", "getTask", {}, 5000);

    expect(capturedOpts).toEqual({ timeoutMs: 5000 });
  });
});

describe("onRetry", () => {
  test("writes a rate-limit message with attempt number and seconds", () => {
    const lines: string[] = [];
    onRetry(2, 1500, "429 Too Many Requests", (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("attempt 2");
    expect(lines[0]).toContain("1.5s");
    expect(lines[0]).toContain("429 Too Many Requests");
  });
});

describe("preflightCheck", () => {
  function neverExit(_code: number): never {
    throw new ExitError(_code);
  }

  test("unknown provider returns silently without calling ipc", async () => {
    let ipcCalled = false;
    const ipc = (async () => {
      ipcCalled = true;
      return [];
    }) as unknown as Parameters<typeof preflightCheck>[1] extends { ipc?: infer I } | undefined ? I : never;

    await preflightCheck("github-issues", { ipc, exit: neverExit });
    expect(ipcCalled).toBe(false);
  });

  test("exits when required MCP server is not configured", async () => {
    const ipc = (async (method: string) => {
      if (method === "listServers") return [{ name: "other" }];
      return [];
    }) as never;

    await expect(preflightCheck("confluence", { ipc, exit: neverExit })).rejects.toThrow("exit(1)");
  });

  test("exits when server is configured but returns no tools", async () => {
    const ipc = (async (method: string) => {
      if (method === "listServers") return [{ name: "atlassian" }];
      if (method === "listTools") return [];
      return undefined;
    }) as never;

    await expect(preflightCheck("jira", { ipc, exit: neverExit })).rejects.toThrow("exit(1)");
  });

  test("exits with daemon-not-running message on ECONNREFUSED", async () => {
    const ipc = (async () => {
      throw new Error("connect ECONNREFUSED /tmp/mcpd.sock");
    }) as never;

    await expect(preflightCheck("confluence", { ipc, exit: neverExit })).rejects.toThrow("exit(1)");
  });

  test("exits with generic message on unexpected error", async () => {
    const ipc = (async () => {
      throw new Error("something weird");
    }) as never;

    await expect(preflightCheck("asana", { ipc, exit: neverExit })).rejects.toThrow("exit(1)");
  });

  test("returns normally when server has tools", async () => {
    let exitCalled = false;
    const ipc = (async (method: string) => {
      if (method === "listServers") return [{ name: "atlassian" }];
      if (method === "listTools") return [{ name: "searchSpaces" }];
      return undefined;
    }) as never;
    const exit = (_code: number): never => {
      exitCalled = true;
      throw new ExitError(_code);
    };

    await preflightCheck("confluence", { ipc, exit });
    expect(exitCalled).toBe(false);
  });

  test("handles non-Error throw by stringifying", async () => {
    const ipc = (async () => {
      throw "string error";
    }) as never;

    await expect(preflightCheck("confluence", { ipc, exit: neverExit })).rejects.toThrow("exit(1)");
  });
});

describe("resolveProviderFromCache", () => {
  function neverExit(_code: number): never {
    throw new ExitError(_code);
  }

  test("exits when directory is not a cloned repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vfs-spec-"));
    try {
      expect(() => resolveProviderFromCache(tmp, neverExit)).toThrow("exit(1)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exits when cache has no provider scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vfs-spec-"));
    try {
      mkdirSync(join(tmp, ".clone"));
      const cache = new CloneCache(join(tmp, ".clone", "cache.sqlite"));
      cache.close();

      expect(() => resolveProviderFromCache(tmp, neverExit)).toThrow("exit(1)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns provider and name when cache has a scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vfs-spec-"));
    try {
      mkdirSync(join(tmp, ".clone"));
      const cache = new CloneCache(join(tmp, ".clone", "cache.sqlite"));
      cache.saveScopeMeta("confluence", { key: "FOO", cloudId: "c1", resolved: {} });
      cache.close();

      const result = resolveProviderFromCache(tmp, neverExit);
      expect(result.providerName).toBe("confluence");
      expect(result.provider).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
