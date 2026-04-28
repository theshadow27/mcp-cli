/**
 * Self-signed cert for the local WSS listener (issue #1808).
 *
 * mcpd binds a TLS WebSocket on `[::1]` so that mcx-spawned `claude` (which
 * post-2.1.120 enforces a host allowlist + `wss://`) can reach the daemon
 * via the patched-binary IPv6-loopback hostname. The cert is purely for
 * local loopback — never exposed to the network — and is regenerated
 * automatically when missing or near expiry.
 *
 * SANs include `IP:::1`, `IP:127.0.0.1`, and `DNS:localhost` so the same
 * cert works for any local address the daemon ends up serving on.
 *
 * No prod dependency added: shells out to `openssl`, which ships with macOS
 * and is available on every CI image we run on. If `openssl` is missing,
 * `ensureSelfSignedCert` throws a clear actionable error.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { options } from "@mcp-cli/core";

/** Result of a successful certificate ensure call. */
export interface SelfSignedMaterial {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
}

export interface EnsureOptions {
  /** Override the directory where the cert+key are cached. Default: `options.TLS_DIR`. */
  dir?: string;
  /** Force regeneration even if a valid cert is on disk. */
  force?: boolean;
  /** Common name for the cert subject. Default: "localhost". */
  commonName?: string;
  /** Cert lifetime in days (`-days` flag to `openssl req`). Default: 365. */
  validityDays?: number;
  /**
   * Regenerate if the cached cert expires within this many seconds. Default:
   * 7 days. Tuned so daemon restarts don't churn certs but auto-rotation
   * happens before any real-world expiry pain. Lower bound enforced by the
   * test suite (must be > 0).
   */
  renewWithinSeconds?: number;
}

const DEFAULT_RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_VALIDITY_DAYS = 365;
const DEFAULT_COMMON_NAME = "localhost";

/**
 * Resolve the cert paths for a given dir. Exported for tests / consumers
 * that need to point Bun.serve at the on-disk PEM files.
 */
export function certPaths(dir: string): { certPath: string; keyPath: string } {
  return {
    certPath: join(dir, "cert.pem"),
    keyPath: join(dir, "key.pem"),
  };
}

/** Throws if `openssl` is not on PATH. */
function assertOpensslAvailable(): void {
  const r = spawnSync("openssl", ["version"], { encoding: "utf-8", timeout: 5_000 });
  if (r.status !== 0) {
    throw new Error(
      "openssl is required for the local WSS listener but was not found on PATH. " +
        "Install via your package manager (e.g. `brew install openssl`) and retry.",
    );
  }
}

/**
 * Returns true if the cert at `certPath` exists, parses, and won't expire
 * within `renewWithinSeconds`. Any failure is treated as "needs regeneration".
 */
export function isCertFresh(certPath: string, renewWithinSeconds: number): boolean {
  if (!existsSync(certPath)) return false;
  // `openssl x509 -checkend <secs>` exits 0 if cert NOT expiring within that window.
  const r = spawnSync("openssl", ["x509", "-checkend", String(renewWithinSeconds), "-noout", "-in", certPath], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  return r.status === 0;
}

/**
 * Generate a fresh self-signed cert + key into `dir`. Overwrites existing
 * files. Returns the on-disk PEM contents alongside their paths.
 */
export function generateSelfSignedCert(
  dir: string,
  opts: Required<Pick<EnsureOptions, "commonName" | "validityDays">>,
): SelfSignedMaterial {
  assertOpensslAvailable();
  mkdirSync(dir, { recursive: true });
  const { certPath, keyPath } = certPaths(dir);

  // SANs cover both loopback IPs and the canonical hostname. ``-addext`` lets
  // us emit them inline without an external openssl.cnf.
  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    String(opts.validityDays),
    "-subj",
    `/CN=${opts.commonName}`,
    "-addext",
    "subjectAltName=IP:::1,IP:127.0.0.1,DNS:localhost",
  ];

  const r = spawnSync("openssl", args, { encoding: "utf-8", timeout: 30_000 });
  if (r.status !== 0) {
    throw new Error(`openssl req failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  }

  // Restrict key permissions even though it's only loopback material — the
  // file ends up in `~/.mcp-cli/tls/key.pem` and we don't want bystander
  // processes reading it.
  try {
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o644);
  } catch {
    // chmod is best-effort; on platforms where it fails the file is still
    // usable via the same user.
  }

  const cert = readFileSync(certPath, "utf-8");
  const key = readFileSync(keyPath, "utf-8");
  return { cert, key, certPath, keyPath };
}

/**
 * Idempotently make sure a usable self-signed cert exists in `dir`. If the
 * cached cert is missing, unparseable, or about to expire, a new one is
 * generated. The returned object is suitable for direct use as the `tls`
 * field of `Bun.serve`.
 */
export function ensureSelfSignedCert(opts: EnsureOptions = {}): SelfSignedMaterial {
  const dir = opts.dir ?? options.TLS_DIR;
  const renewWithinSeconds = opts.renewWithinSeconds ?? DEFAULT_RENEW_WITHIN_SECONDS;
  const commonName = opts.commonName ?? DEFAULT_COMMON_NAME;
  const validityDays = opts.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (renewWithinSeconds <= 0) {
    throw new Error(`renewWithinSeconds must be > 0, got ${renewWithinSeconds}`);
  }

  mkdirSync(dir, { recursive: true });
  const { certPath, keyPath } = certPaths(dir);

  if (!opts.force && existsSync(keyPath) && isCertFresh(certPath, renewWithinSeconds)) {
    return {
      cert: readFileSync(certPath, "utf-8"),
      key: readFileSync(keyPath, "utf-8"),
      certPath,
      keyPath,
    };
  }

  return generateSelfSignedCert(dir, { commonName, validityDays });
}

/**
 * Read and return the cached cert without regenerating. Returns null when
 * the cert is missing or unparseable. Useful for callers that only want to
 * use a cert if one already exists (e.g. a status command that doesn't want
 * to silently provision one).
 */
export function readCachedCert(dir?: string): SelfSignedMaterial | null {
  const resolved = dir ?? options.TLS_DIR;
  const { certPath, keyPath } = certPaths(resolved);
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  try {
    return {
      cert: readFileSync(certPath, "utf-8"),
      key: readFileSync(keyPath, "utf-8"),
      certPath,
      keyPath,
    };
  } catch {
    return null;
  }
}
