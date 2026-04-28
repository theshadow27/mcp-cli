import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certPaths, ensureSelfSignedCert, generateSelfSignedCert, isCertFresh, readCachedCert } from "./self-signed";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "tls-test-"));
}

describe("certPaths", () => {
  test("derives cert.pem and key.pem under the given dir", () => {
    const p = certPaths("/some/dir");
    expect(p.certPath).toBe("/some/dir/cert.pem");
    expect(p.keyPath).toBe("/some/dir/key.pem");
  });
});

describe("generateSelfSignedCert", () => {
  test("writes cert + key with PEM markers", () => {
    const dir = freshDir();
    const m = generateSelfSignedCert(dir, { commonName: "localhost", validityDays: 30 });
    expect(m.cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(m.key).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(existsSync(m.certPath)).toBe(true);
    expect(existsSync(m.keyPath)).toBe(true);
  });

  test("cert SAN includes ::1, 127.0.0.1, and localhost", () => {
    const dir = freshDir();
    const { certPath } = generateSelfSignedCert(dir, {
      commonName: "localhost",
      validityDays: 30,
    });
    const r = spawnSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain("IP Address:0:0:0:0:0:0:0:1");
    expect(out).toContain("IP Address:127.0.0.1");
    expect(out).toContain("DNS:localhost");
  });

  test("key file is mode 0600", () => {
    const dir = freshDir();
    const { keyPath } = generateSelfSignedCert(dir, { commonName: "localhost", validityDays: 30 });
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("isCertFresh", () => {
  test("returns false when file is missing", () => {
    expect(isCertFresh("/nonexistent/path/cert.pem", 60)).toBe(false);
  });

  test("returns true for a freshly generated cert with renew window of 1 day", () => {
    const dir = freshDir();
    const { certPath } = generateSelfSignedCert(dir, { commonName: "localhost", validityDays: 30 });
    expect(isCertFresh(certPath, 24 * 60 * 60)).toBe(true);
  });

  test("returns false when cert is within the renew window", () => {
    const dir = freshDir();
    const { certPath } = generateSelfSignedCert(dir, { commonName: "localhost", validityDays: 1 });
    // A 1-day cert is "expiring within 7 days" → not fresh.
    expect(isCertFresh(certPath, 7 * 24 * 60 * 60)).toBe(false);
  });

  test("returns false for unparseable PEM file", () => {
    const dir = freshDir();
    const certPath = join(dir, "cert.pem");
    writeFileSync(certPath, "not actually a cert", { mode: 0o644 });
    expect(isCertFresh(certPath, 60)).toBe(false);
  });
});

describe("ensureSelfSignedCert", () => {
  test("generates on first call when dir is empty", () => {
    const dir = freshDir();
    const m = ensureSelfSignedCert({ dir, validityDays: 30 });
    expect(m.cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(existsSync(m.certPath)).toBe(true);
  });

  test("reuses cached cert on second call (no regeneration)", () => {
    const dir = freshDir();
    const first = ensureSelfSignedCert({ dir, validityDays: 30 });
    const second = ensureSelfSignedCert({ dir, validityDays: 30 });
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  test("regenerates when force=true", () => {
    const dir = freshDir();
    const first = ensureSelfSignedCert({ dir, validityDays: 30 });
    const second = ensureSelfSignedCert({ dir, validityDays: 30, force: true });
    // Self-signed RSA generation produces different keys each call, so cert and key both differ.
    expect(second.cert).not.toBe(first.cert);
    expect(second.key).not.toBe(first.key);
  });

  test("regenerates when cached cert is within the renew window", () => {
    const dir = freshDir();
    // First, write a 1-day cert.
    const first = ensureSelfSignedCert({ dir, validityDays: 1, renewWithinSeconds: 60 });
    // Then ask for a cert that must be valid for at least 7 days — old one fails the check.
    const second = ensureSelfSignedCert({ dir, validityDays: 30, renewWithinSeconds: 7 * 24 * 60 * 60 });
    expect(second.cert).not.toBe(first.cert);
  });

  test("regenerates when cached cert is unparseable", () => {
    const dir = freshDir();
    // Plant garbage that mimics the cached layout.
    const { certPath, keyPath } = certPaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(certPath, "garbage", { mode: 0o644 });
    writeFileSync(keyPath, "garbage", { mode: 0o600 });
    const m = ensureSelfSignedCert({ dir, validityDays: 30 });
    expect(m.cert).toContain("-----BEGIN CERTIFICATE-----");
  });

  test("rejects renewWithinSeconds <= 0", () => {
    const dir = freshDir();
    expect(() => ensureSelfSignedCert({ dir, renewWithinSeconds: 0 })).toThrow();
    expect(() => ensureSelfSignedCert({ dir, renewWithinSeconds: -1 })).toThrow();
  });
});

describe("readCachedCert", () => {
  test("returns null when no cert is cached", () => {
    const dir = freshDir();
    expect(readCachedCert(dir)).toBeNull();
  });

  test("returns null when only one of cert/key exists", () => {
    const dir = freshDir();
    const { certPath } = certPaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(certPath, "stub", { mode: 0o644 });
    expect(readCachedCert(dir)).toBeNull();
  });

  test("returns material when both files exist", () => {
    const dir = freshDir();
    const generated = ensureSelfSignedCert({ dir, validityDays: 30 });
    const cached = readCachedCert(dir);
    expect(cached?.cert).toBe(generated.cert);
    expect(cached?.key).toBe(generated.key);
  });
});

describe("integration: Bun.serve TLS handshake on [::1]", () => {
  // The spawned claude process trusts our loopback cert via
  // `NODE_TLS_REJECT_UNAUTHORIZED=0`. The cleaner option (NODE_EXTRA_CA_CERTS
  // additive trust) is not honored by Bun's WebSocket client today —
  // verified against bun 1.3.13: `WebSocketUpgradeClient.zig:281-306` only
  // pulls a custom CA from an explicit `ssl_config` constructor option,
  // and `SSL_CTX_set_default_verify_paths` is never called in the tree.
  // System-keychain trust + `NODE_USE_SYSTEM_CA=1` is the secure-by-default
  // upgrade — see issue #1829 for the daemon power-on-self-test that
  // detects when system trust is in place and prefers it automatically.
  test("subprocess with NODE_TLS_REJECT_UNAUTHORIZED=0 connects to wss://[::1]", async () => {
    const dir = freshDir();
    const { cert, key } = ensureSelfSignedCert({ dir, validityDays: 30 });

    let opened = false;
    const server = Bun.serve({
      hostname: "::1",
      port: 0,
      tls: { cert, key },
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("ok");
      },
      websocket: {
        open() {
          opened = true;
        },
        message() {},
        close() {},
      },
    });
    try {
      const port = server.port as number;
      const url = `wss://[::1]:${port}/`;
      const scriptPath = join(dir, "client.ts");
      writeFileSync(
        scriptPath,
        `const ws = new WebSocket(${JSON.stringify(url)});
const deadline = Date.now() + 4000;
while (Date.now() < deadline && ws.readyState === WebSocket.CONNECTING) {
  await Bun.sleep(20);
}
if (ws.readyState !== WebSocket.OPEN) {
  process.stderr.write('readyState=' + ws.readyState + '\\n');
  process.exit(1);
}
ws.close();
process.stdout.write('OK');
`,
      );
      const proc = Bun.spawn({
        cmd: ["bun", scriptPath],
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(stdout).toBe("OK");
      expect(exitCode).toBe(0);
      const handlerDeadline = Date.now() + 1_000;
      while (!opened && Date.now() < handlerDeadline) {
        await Bun.sleep(20);
      }
      expect(opened).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("subprocess without trust override rejects the self-signed cert", async () => {
    // Negative control: confirms we're actually exercising the trust path
    // and not accidentally running with a permissive default elsewhere.
    const dir = freshDir();
    const { cert, key } = ensureSelfSignedCert({ dir, validityDays: 30 });

    const server = Bun.serve({
      hostname: "::1",
      port: 0,
      tls: { cert, key },
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("ok");
      },
      websocket: { open() {}, message() {}, close() {} },
    });
    try {
      const port = server.port as number;
      const url = `wss://[::1]:${port}/`;
      const scriptPath = join(dir, "client-negative.ts");
      writeFileSync(
        scriptPath,
        `const ws = new WebSocket(${JSON.stringify(url)});
const deadline = Date.now() + 4000;
while (Date.now() < deadline && ws.readyState === WebSocket.CONNECTING) {
  await Bun.sleep(20);
}
process.stdout.write('readyState=' + ws.readyState);
`,
      );
      const { NODE_EXTRA_CA_CERTS: _ignoredExtra, NODE_TLS_REJECT_UNAUTHORIZED: _ignoredReject, ...env } = process.env;
      const proc = Bun.spawn({
        cmd: ["bun", scriptPath],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      // Without the trust override, the client either errors out (CLOSED=3)
      // or never gets past CONNECTING within the deadline. Either is "not OPEN".
      expect(stdout).not.toContain("readyState=1");
    } finally {
      server.stop(true);
    }
  });
});
