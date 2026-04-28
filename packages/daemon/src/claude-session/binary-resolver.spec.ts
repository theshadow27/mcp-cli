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

  test('noop strategy (claude < 2.1.120) → resolved with no TLS, binaryPath="claude" (PATH lookup preserved)', async () => {
    const r = await resolveClaudeForSpawn(makeDeps({ versionResolver: async () => "2.1.119" }));
    expect(isResolved(r)).toBe(true);
    if (!isResolved(r)) throw new Error("typeguard");
    // Preserves legacy PATH-resolved spawn — never an absolute path.
    expect(r.binaryPath).toBe("claude");
    expect(r.tlsConfig).toBeNull();
    expect(r.strategyId).toBe("noop-pre-2.1.120");
    expect(r.version).toBe("2.1.119");
    // sourcePath is informational only — `which claude` result, not the spawn target.
    expect(r.sourcePath).toBe("/usr/local/bin/claude");
  });

  test("unsupported version → unsupported-version error", async () => {
    const r = await resolveClaudeForSpawn(makeDeps({ versionResolver: async () => "9.9.9" }));
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
    };
    expect(isResolved(ok)).toBe(true);
    expect(isResolved(err)).toBe(false);
  });
});
