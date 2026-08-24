import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchedMeta } from "@mcp-cli/core";
import type { SelfSignedMaterial } from "../tls/self-signed";
import { isResolved, resolveClaudeForSpawn } from "./binary-resolver";
import type { ResolverDeps } from "./binary-resolver";

function fakeCert(): SelfSignedMaterial {
  return {
    cert: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
    key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
    certPath: "/fake/cert.pem",
    keyPath: "/fake/key.pem",
  };
}

function makeDeps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    resolveSourcePath: () => "/usr/local/bin/claude",
    versionResolver: async () => "2.1.119",
    readPatchedMeta: () => null,
    ensureCert: fakeCert,
    ...over,
  };
}

describe("resolveClaudeForSpawn", () => {
  test("no claude on PATH → no-claude error", async () => {
    const r = await resolveClaudeForSpawn(makeDeps({ resolveSourcePath: () => null }));
    expect(isResolved(r)).toBe(false);
    if (isResolved(r)) throw new Error("typeguard");
    expect(r.reason).toBe("no-claude");
    expect(r.version).toBeNull();
    expect(r.error).toMatch(/not found on PATH/);
  });

  test("version probe failure → version-probe-failed error", async () => {
    const r = await resolveClaudeForSpawn(
      makeDeps({
        versionResolver: async () => {
          throw new Error("exit 137");
        },
      }),
    );
    expect(isResolved(r)).toBe(false);
    if (isResolved(r)) throw new Error("typeguard");
    expect(r.reason).toBe("version-probe-failed");
    expect(r.error).toMatch(/exit 137/);
  });

  test("noop strategy (claude < 2.1.120) → resolved with no TLS, binaryPath = resolved sourcePath", async () => {
    const r = await resolveClaudeForSpawn(makeDeps({ versionResolver: async () => "2.1.119" }));
    expect(isResolved(r)).toBe(true);
    if (!isResolved(r)) throw new Error("typeguard");
    // binaryPath now matches sourcePath so config / env overrides actually
    // pin the spawn target; previously this returned the literal string
    // "claude" and PATH-resolved at spawn time, silently bypassing overrides.
    expect(r.binaryPath).toBe("/usr/local/bin/claude");
    expect(r.binaryPath).toBe(r.sourcePath);
    expect(r.tlsConfig).toBeNull();
    expect(r.strategyId).toBe("noop-pre-2.1.120");
    expect(r.version).toBe("2.1.119");
    expect(r.sourcePath).toBe("/usr/local/bin/claude");
  });

  test("unsupported version → unsupported-version error", async () => {
    // Inject empty registry — built-in registry has no gaps so "unsupported"
    // is otherwise unreachable. See strategies.ts for the rationale.
    const r = await resolveClaudeForSpawn(makeDeps({ versionResolver: async () => "9.9.9", strategies: [] }));
    expect(isResolved(r)).toBe(false);
    if (isResolved(r)) throw new Error("typeguard");
    expect(r.reason).toBe("unsupported-version");
    expect(r.error).toMatch(/9\.9\.9/);
    expect(r.error).toMatch(/Upgrade mcx/);
  });

  test("patched required, no patched meta → patch-missing error", async () => {
    const r = await resolveClaudeForSpawn(
      makeDeps({
        versionResolver: async () => "2.1.121",
        readPatchedMeta: () => null,
      }),
    );
    expect(isResolved(r)).toBe(false);
    if (isResolved(r)) throw new Error("typeguard");
    expect(r.reason).toBe("patch-missing");
    expect(r.error).toMatch(/mcx claude patch-update/);
    expect(r.error).toMatch(/2\.1\.121/);
  });

  test("patched meta version mismatch → patch-stale error", async () => {
    const meta: PatchedMeta = {
      version: "2.1.120",
      strategyId: "host-check-ipv6-loopback-v1",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc",
      signedAt: "2026-04-27T00:00:00Z",
    };
    const r = await resolveClaudeForSpawn(
      makeDeps({
        versionResolver: async () => "2.1.121",
        readPatchedMeta: () => meta,
      }),
    );
    expect(isResolved(r)).toBe(false);
    if (isResolved(r)) throw new Error("typeguard");
    expect(r.reason).toBe("patch-stale");
    expect(r.error).toMatch(/auto-updated/);
  });

  test("patched binary file missing → patched-binary-missing error", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
    // meta exists but file doesn't
    const meta: PatchedMeta = {
      version: "2.1.121",
      strategyId: "host-check-ipv6-loopback-v1",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc",
      signedAt: "2026-04-27T00:00:00Z",
    };
    const r = await resolveClaudeForSpawn(
      makeDeps({
        versionResolver: async () => "2.1.121",
        readPatchedMeta: () => meta,
        patchedStoreDir: storeDir,
      }),
    );
    expect(isResolved(r)).toBe(false);
    if (isResolved(r)) throw new Error("typeguard");
    expect(r.reason).toBe("patched-binary-missing");
    expect(r.error).toMatch(/--force/);
  });

  test("patched binary present → resolved with TLS", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
    const patchedPath = join(storeDir, "2.1.121.patched");
    writeFileSync(patchedPath, "stub patched binary", { mode: 0o755 });
    const meta: PatchedMeta = {
      version: "2.1.121",
      strategyId: "host-check-ipv6-loopback-v1",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc",
      signedAt: "2026-04-27T00:00:00Z",
    };
    let certCalled = 0;
    const r = await resolveClaudeForSpawn(
      makeDeps({
        versionResolver: async () => "2.1.121",
        readPatchedMeta: () => meta,
        patchedStoreDir: storeDir,
        ensureCert: () => {
          certCalled++;
          return fakeCert();
        },
      }),
    );
    expect(isResolved(r)).toBe(true);
    if (!isResolved(r)) throw new Error("typeguard");
    expect(r.binaryPath).toBe(patchedPath);
    expect(r.tlsConfig?.cert).toContain("BEGIN CERTIFICATE");
    expect(r.tlsConfig?.key).toContain("BEGIN PRIVATE KEY");
    expect(r.strategyId).toBe("host-check-ipv6-loopback-v1");
    expect(r.version).toBe("2.1.121");
    expect(r.sourcePath).toBe("/usr/local/bin/claude");
    expect(certCalled).toBe(1);
  });

  // #3013: the listener's TLS mode has to follow the claude *version*, not the
  // freshness of the patched copy. When those two were coupled, a daemon that
  // came up on a stale patch bound plain ws — so even after `patch-update`
  // fixed the store, spawning could only be re-enabled by restarting the daemon
  // (a wss:// listener cannot be conjured under a running one).
  describe("TLS on the error branches (#3013)", () => {
    const staleMeta: PatchedMeta = {
      version: "2.1.120",
      strategyId: "host-check-ipv6-loopback-v1",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc",
      signedAt: "2026-04-27T00:00:00Z",
    };

    test("patch-missing still carries TLS material", async () => {
      const r = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "2.1.121", readPatchedMeta: () => null }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(r.reason).toBe("patch-missing");
      expect(r.tlsConfig?.cert).toContain("BEGIN CERTIFICATE");
      expect(r.tlsConfig?.key).toContain("BEGIN PRIVATE KEY");
    });

    test("patch-stale still carries TLS material", async () => {
      const r = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "2.1.121", readPatchedMeta: () => staleMeta }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(r.reason).toBe("patch-stale");
      expect(r.tlsConfig?.cert).toContain("BEGIN CERTIFICATE");
    });

    test("patched-binary-missing still carries TLS material", async () => {
      const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
      const r = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => ({ ...staleMeta, version: "2.1.121" }),
          patchedStoreDir: storeDir,
        }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(r.reason).toBe("patched-binary-missing");
      expect(r.tlsConfig?.cert).toContain("BEGIN CERTIFICATE");
    });

    test("pre-patch failures carry no TLS material — the version is unknown or unsupported", async () => {
      const noClaude = await resolveClaudeForSpawn(makeDeps({ resolveSourcePath: () => null }));
      if (isResolved(noClaude)) throw new Error("typeguard");
      expect(noClaude.tlsConfig).toBeNull();

      const probeFailed = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => {
            throw new Error("exit 137");
          },
        }),
      );
      if (isResolved(probeFailed)) throw new Error("typeguard");
      expect(probeFailed.tlsConfig).toBeNull();

      const unsupported = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "9.9.9", strategies: [] }),
      );
      if (isResolved(unsupported)) throw new Error("typeguard");
      expect(unsupported.tlsConfig).toBeNull();
    });

    test("a cert failure degrades the error branch to plain ws instead of throwing", async () => {
      // Spawning is already refused with an actionable message here; turning
      // that into a worker-startup crash would also take out list/log/wait.
      const r = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => staleMeta,
          ensureCert: () => {
            throw new Error("openssl not found");
          },
        }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(r.reason).toBe("patch-stale");
      expect(r.tlsConfig).toBeNull();
    });

    test("a cert failure on the RESOLVED path still throws — plain ws would silently break the patched binary", async () => {
      const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
      const patchedPath = join(storeDir, "2.1.121.patched");
      writeFileSync(patchedPath, "stub patched binary", { mode: 0o755 });
      await expect(
        resolveClaudeForSpawn(
          makeDeps({
            versionResolver: async () => "2.1.121",
            readPatchedMeta: () => ({ ...staleMeta, version: "2.1.121" }),
            patchedStoreDir: storeDir,
            ensureCert: () => {
              throw new Error("openssl not found");
            },
          }),
        ),
      ).rejects.toThrow(/openssl not found/);
    });
  });

  test("noop strategy never reads patched meta or generates a cert", async () => {
    let metaReads = 0;
    let certCalls = 0;
    const r = await resolveClaudeForSpawn(
      makeDeps({
        versionResolver: async () => "2.1.91",
        readPatchedMeta: () => {
          metaReads++;
          return null;
        },
        ensureCert: () => {
          certCalls++;
          return fakeCert();
        },
      }),
    );
    expect(isResolved(r)).toBe(true);
    expect(metaReads).toBe(0);
    expect(certCalls).toBe(0);
  });
});

describe("isResolved typeguard", () => {
  test("narrows ResolvedClaude vs UnresolvedClaude", () => {
    const ok: import("./binary-resolver").ClaudeResolution = {
      binaryPath: "/x",
      tlsConfig: null,
      strategyId: "noop-pre-2.1.120",
      version: "2.1.119",
      sourcePath: "/x",
    };
    const err: import("./binary-resolver").ClaudeResolution = {
      error: "no",
      reason: "no-claude",
      version: null,
      tlsConfig: null,
    };
    expect(isResolved(ok)).toBe(true);
    expect(isResolved(err)).toBe(false);
  });
});
