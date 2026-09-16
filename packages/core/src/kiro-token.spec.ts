import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kiroDataDir, kiroDbPath, resolveKiroToken } from "./kiro-token";

/**
 * These tests drive the on-disk (Linux/fallback) path deterministically by pointing
 * XDG_DATA_HOME at a temp dir and seeding a `data.sqlite3` with the same schema
 * kiro-cli uses. The Keychain reader is injected as "empty" so the suite is identical
 * on macOS and Linux; the real `/usr/bin/security` path is exercised manually.
 */

/** Inject an empty keychain so only the seeded on-disk store is consulted. */
const NO_KEYCHAIN = { keychain: () => null } as const;

interface SeedOpts {
  token?: Record<string, unknown> | string | null;
  profile?: Record<string, unknown> | string | null;
}

/** Create a temp kiro data dir with a seeded auth store; returns an env pointing at it. */
function seedStore(opts: SeedOpts): { env: NodeJS.ProcessEnv; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "kiro-token-"));
  const env: NodeJS.ProcessEnv = { MCX_KIRO_DATA_DIR: base };
  const dataDir = kiroDataDir(env);
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(kiroDbPath(env));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)");
  if (opts.token !== undefined && opts.token !== null) {
    const v = typeof opts.token === "string" ? opts.token : JSON.stringify(opts.token);
    db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:odic:token", v]);
  }
  if (opts.profile !== undefined && opts.profile !== null) {
    const v = typeof opts.profile === "string" ? opts.profile : JSON.stringify(opts.profile);
    db.run("INSERT INTO state (key, value) VALUES (?, ?)", ["api.codewhisperer.profile", v]);
  }
  db.close();
  return { env, dir: base };
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

describe("resolveKiroToken (on-disk store)", () => {
  test("returns a valid access token from auth_kv", () => {
    const { env, dir } = seedStore({ token: { access_token: "tok-abc", expires_at: FUTURE, region: "eu-west-1" } });
    try {
      const token = resolveKiroToken(env, NO_KEYCHAIN);
      expect(token?.accessToken).toBe("tok-abc");
      expect(token?.expiresAtIso).toBe(FUTURE);
      expect(token?.region).toBe("eu-west-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merges the CodeWhisperer profile ARN from the state table", () => {
    const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC123";
    const { env, dir } = seedStore({
      token: { access_token: "tok-abc", expires_at: FUTURE },
      profile: { arn, profile_name: "KiroProfile-eu-central-1" },
    });
    try {
      expect(resolveKiroToken(env, NO_KEYCHAIN)?.profileArn).toBe(arn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an expired token", () => {
    const { env, dir } = seedStore({ token: { access_token: "stale", expires_at: PAST } });
    try {
      expect(resolveKiroToken(env, NO_KEYCHAIN)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the token document has no access_token", () => {
    const { env, dir } = seedStore({ token: { expires_at: FUTURE } });
    try {
      expect(resolveKiroToken(env, NO_KEYCHAIN)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null on malformed JSON rather than throwing", () => {
    const { env, dir } = seedStore({ token: "{not json" });
    try {
      expect(resolveKiroToken(env, NO_KEYCHAIN)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when no store exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "kiro-empty-"));
    try {
      expect(resolveKiroToken({ MCX_KIRO_DATA_DIR: empty }, NO_KEYCHAIN)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("MCX_KIRO_DISABLE_TOKEN_LOOKUP=1 short-circuits to null even with a valid store", () => {
    const { env, dir } = seedStore({ token: { access_token: "tok-abc", expires_at: FUTURE } });
    try {
      expect(resolveKiroToken({ ...env, MCX_KIRO_DISABLE_TOKEN_LOOKUP: "1" }, NO_KEYCHAIN)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
