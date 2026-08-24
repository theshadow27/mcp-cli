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

    test("a degraded cert load is reported to the caller instead of degrading in silence", async () => {
      // Without this the daemon pins itself to plain ws for its whole lifetime
      // and nothing anywhere says why (#3289 review).
      const seen: string[] = [];
      const r = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => staleMeta,
          ensureCert: () => {
            throw new Error("openssl not found");
          },
          onCertError: (err) => seen.push(err instanceof Error ? err.message : String(err)),
        }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(r.tlsConfig).toBeNull();
      expect(seen).toEqual(["openssl not found"]);
    });
  });

  // #3289: `listenerTls` states what the *binary* needs of the listener,
  // independently of whether material was loaded (or could be). A live daemon
  // compares it against the listener it already bound — see
  // ClaudeWsServer.applySpawnResolution.
  describe("listenerTls (#3289)", () => {
    const meta: PatchedMeta = {
      version: "2.1.121",
      strategyId: "host-check-ipv6-loopback-v1",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc",
      signedAt: "2026-04-27T00:00:00Z",
    };

    test("a noop-strategy claude needs plain ws", async () => {
      const r = await resolveClaudeForSpawn(makeDeps({ versionResolver: async () => "2.1.119" }));
      if (!isResolved(r)) throw new Error("typeguard");
      expect(r.listenerTls).toBe("plain-ws");
    });

    test("a patched claude needs wss", async () => {
      const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
      writeFileSync(join(storeDir, "2.1.121.patched"), "stub", { mode: 0o755 });
      const r = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "2.1.121", readPatchedMeta: () => meta, patchedStoreDir: storeDir }),
      );
      if (!isResolved(r)) throw new Error("typeguard");
      expect(r.listenerTls).toBe("wss");
    });

    test("the patch-* branches need wss even while refusing to spawn", async () => {
      const missing = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "2.1.121", readPatchedMeta: () => null }),
      );
      const stale = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "2.1.121", readPatchedMeta: () => ({ ...meta, version: "2.1.120" }) }),
      );
      const gone = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => meta,
          patchedStoreDir: mkdtempSync(join(tmpdir(), "binary-resolver-")),
        }),
      );
      for (const r of [missing, stale, gone]) {
        if (isResolved(r)) throw new Error("typeguard");
        expect(r.listenerTls).toBe("wss");
      }
    });

    test("a cert failure does not change what the binary needs — only what we could load", async () => {
      const r = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => ({ ...meta, version: "2.1.120" }),
          ensureCert: () => {
            throw new Error("openssl not found");
          },
        }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(r.tlsConfig).toBeNull();
      expect(r.listenerTls).toBe("wss");
    });

    test("the pre-patch failures report an unknown requirement, not plain ws", async () => {
      // The distinction is the whole point: "plain-ws" would let a live
      // plain-ws listener happily adopt a patched binary it cannot serve.
      const noClaude = await resolveClaudeForSpawn(makeDeps({ resolveSourcePath: () => null }));
      const probeFailed = await resolveClaudeForSpawn(
        makeDeps({
          versionResolver: async () => {
            throw new Error("exit 137");
          },
        }),
      );
      const unsupported = await resolveClaudeForSpawn(
        makeDeps({ versionResolver: async () => "9.9.9", strategies: [] }),
      );
      for (const r of [noClaude, probeFailed, unsupported]) {
        if (isResolved(r)) throw new Error("typeguard");
        expect(r.listenerTls).toBe("unknown");
      }
    });
  });

  // #3289: the post-startup refresh runs on the thread serving live sessions.
  // `ensureSelfSignedCert` shells out to openssl up to four times, once for an
  // RSA keygen — all synchronous, all of it stalling those sessions, and none
  // of it usable by a caller that cannot rebind the listener anyway.
  describe("mode: spawn-only (#3289)", () => {
    const meta: PatchedMeta = {
      version: "2.1.121",
      strategyId: "host-check-ipv6-loopback-v1",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc",
      signedAt: "2026-04-27T00:00:00Z",
    };

    test("resolving a patched binary loads no cert, and still reports the wss requirement", async () => {
      const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
      writeFileSync(join(storeDir, "2.1.121.patched"), "stub", { mode: 0o755 });
      let certCalls = 0;
      const r = await resolveClaudeForSpawn(
        makeDeps({
          mode: "spawn-only",
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => meta,
          patchedStoreDir: storeDir,
          ensureCert: () => {
            certCalls++;
            return fakeCert();
          },
        }),
      );
      if (!isResolved(r)) throw new Error("typeguard");
      expect(certCalls).toBe(0);
      expect(r.tlsConfig).toBeNull();
      expect(r.listenerTls).toBe("wss");
      expect(r.binaryPath).toBe(join(storeDir, "2.1.121.patched"));
    });

    test("a broken cert path cannot fail a spawn-only resolution at all", async () => {
      // The resolved path is loud about a cert failure when a listener is
      // about to be bound. Here there is no listener to bind, so an unusable
      // openssl must not turn a perfectly good binary resolution into a throw.
      const storeDir = mkdtempSync(join(tmpdir(), "binary-resolver-"));
      writeFileSync(join(storeDir, "2.1.121.patched"), "stub", { mode: 0o755 });
      const r = await resolveClaudeForSpawn(
        makeDeps({
          mode: "spawn-only",
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => meta,
          patchedStoreDir: storeDir,
          ensureCert: () => {
            throw new Error("openssl not found");
          },
        }),
      );
      expect(isResolved(r)).toBe(true);
    });

    test("the error branches load no cert either", async () => {
      let certCalls = 0;
      const r = await resolveClaudeForSpawn(
        makeDeps({
          mode: "spawn-only",
          versionResolver: async () => "2.1.121",
          readPatchedMeta: () => ({ ...meta, version: "2.1.120" }),
          ensureCert: () => {
            certCalls++;
            return fakeCert();
          },
        }),
      );
      if (isResolved(r)) throw new Error("typeguard");
      expect(certCalls).toBe(0);
      expect(r.reason).toBe("patch-stale");
      expect(r.tlsConfig).toBeNull();
      expect(r.listenerTls).toBe("wss");
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
      listenerTls: "plain-ws",
      strategyId: "noop-pre-2.1.120",
      version: "2.1.119",
      sourcePath: "/x",
    };
    const err: import("./binary-resolver").ClaudeResolution = {
      error: "no",
      reason: "no-claude",
      version: null,
      tlsConfig: null,
      listenerTls: "unknown",
    };
    expect(isResolved(ok)).toBe(true);
    expect(isResolved(err)).toBe(false);
  });
});
