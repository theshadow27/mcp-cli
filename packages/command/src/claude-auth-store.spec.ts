import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaRateLimitError, flockUnlock, tryFlockExclusive } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import {
  type AuthErrorCode,
  type AuthPaths,
  AuthProfileError,
  type ClaudeAuthProfile,
  assertPlatformSupported,
  defaultAuthPaths,
  fetchUnexpiredProfileQuotas,
  isOauthTokenExpired,
  listProfiles,
  loadProfile,
  patchClaudeConfigIdentity,
  readActivePointer,
  readActiveProfileName,
  readLiveState,
  readProfile,
  refreshProfileCredentialsFromLive,
  saveProfile,
  snapshotQuotaFromCredentials,
  stampActiveProfileQuota,
  stampProfileQuota,
  summarizeProfile,
  withExclusiveLock,
  writeFileAtomic,
  writeProfile,
} from "./claude-auth-store";

// ── Fixtures ──

const ACCESS_TOKEN = "sk-ant-oat01-FAKE-ACCESS-TOKEN-DO-NOT-LOG";
const REFRESH_TOKEN = "sk-ant-ort01-FAKE-REFRESH-TOKEN-DO-NOT-LOG";
const EXPIRES_AT = Date.UTC(2026, 7, 19, 3, 14, 0);
const NOW = new Date(Date.UTC(2026, 7, 18, 12, 0, 0));

function credentials(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: EXPIRES_AT,
      refreshTokenExpiresAt: EXPIRES_AT + 86_400_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      ...overrides,
    },
  };
}

function oauthAccount(email: string): Record<string, unknown> {
  return { accountUuid: `uuid-${email}`, emailAddress: email, organizationName: "Acme" };
}

interface Sandbox extends AuthPaths {
  root: string;
  [Symbol.dispose](): void;
}

/** Temp filesystem standing in for `~/.claude` + `~/.mcp-cli`. Never touches the real home. */
function sandbox(opts?: {
  credentials?: Record<string, unknown> | null;
  claudeConfig?: Record<string, unknown> | null;
  policy?: Record<string, unknown> | null;
}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "mcx-auth-"));
  const claudeHome = join(root, ".claude");
  mkdirSync(claudeHome, { recursive: true });

  const paths: AuthPaths = {
    profilesDir: join(root, ".mcp-cli", "auth-profiles"),
    credentialsPath: join(claudeHome, ".credentials.json"),
    claudeConfigPath: join(root, ".claude.json"),
    policyLimitsPath: join(claudeHome, "policy-limits.json"),
  };

  const creds = opts?.credentials === undefined ? credentials() : opts.credentials;
  if (creds) writeFileSync(paths.credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

  const config =
    opts?.claudeConfig === undefined
      ? { userID: "user-a", oauthAccount: oauthAccount("a@example.com"), projects: { "/repo": { allowedTools: [] } } }
      : opts.claudeConfig;
  if (config) writeFileSync(paths.claudeConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const policy =
    opts?.policy === undefined ? { restrictions: { allow_remote_control: { allowed: false } } } : opts.policy;
  if (policy) writeFileSync(paths.policyLimitsPath, JSON.stringify(policy, null, 2), { mode: 0o600 });

  return {
    ...paths,
    root,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function save(paths: AuthPaths, name: string, env: Record<string, string | undefined> = {}, apiKeyEnvVar?: string) {
  return saveProfile({ paths, name, env, now: NOW, platform: "linux", apiKeyEnvVar });
}

function load(paths: AuthPaths, name: string, env: Record<string, string | undefined> = {}) {
  return loadProfile({ paths, name, env, now: NOW, platform: "linux" });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/**
 * Run `fn`, assert it threw an `AuthProfileError` with `code`, and hand the error back.
 * Keeps the assertion inside the catch (the `test-empty-catch` rule) while still letting
 * callers make further assertions about the state the failure left behind.
 */
function expectAuthError(fn: () => unknown, code: AuthErrorCode): AuthProfileError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthProfileError);
    expect((err as AuthProfileError).code).toBe(code);
    return err as AuthProfileError;
  }
  throw new Error(`expected an AuthProfileError with code "${code}"`);
}

/** Access token inside a credential blob — used only to prove bytes survived, never printed. */
function accessTokenOf(rawCredentials: string): string {
  const token = JSON.parse(rawCredentials).claudeAiOauth?.accessToken;
  if (typeof token !== "string") throw new Error("fixture has no access token");
  return token;
}

/**
 * Invariant (a) probe: does the outgoing credential blob exist anywhere under the
 * profile store (profile file or backup)? Asserts on the bytes that survived rather
 * than on what the API claims it did.
 */
function storeContainsCredentials(paths: AuthPaths, rawCredentials: string): boolean {
  const needle = accessTokenOf(rawCredentials);
  const walk = (dir: string): boolean => {
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
        continue;
      }
      if (readFileSync(full, "utf-8").includes(needle)) return true;
    }
    return false;
  };
  return walk(paths.profilesDir);
}

// ── save ──

describe("saveProfile", () => {
  test("captures credentials and identity, creates 0700 dir with 0600 files", () => {
    using fs = sandbox();
    const result = save(fs, "work");

    expect(result.profile.kind).toBe("oauth");
    expect(result.replaced).toBe(false);
    expect(result.becameActive).toBe(true);
    expect(result.profile.credentials).toEqual(credentials());
    expect(result.profile.identity?.userID).toBe("user-a");
    expect(mode(fs.profilesDir)).toBe(0o700);
    expect(mode(join(fs.profilesDir, "work.json"))).toBe(0o600);
    expect(readActiveProfileName(fs)).toBe("work");
  });

  test("records the org-policy remote-control flag", () => {
    using fs = sandbox();
    expect(save(fs, "work").profile.policy?.allowRemoteControl).toBe(false);
  });

  test("second save of the same name updates in place and keeps createdAt", () => {
    using fs = sandbox();
    const first = save(fs, "work");
    const later = new Date(NOW.getTime() + 60_000);
    const second = saveProfile({ paths: fs, name: "work", env: {}, now: later, platform: "linux" });

    expect(second.replaced).toBe(true);
    expect(second.profile.createdAt).toBe(first.profile.createdAt);
    expect(second.profile.updatedAt).toBe(later.toISOString());
  });

  test("throws no-credentials when nothing is logged in", () => {
    using fs = sandbox({ credentials: null });
    expect(() => save(fs, "work")).toThrow(AuthProfileError);
    try {
      save(fs, "work");
    } catch (err) {
      expect((err as AuthProfileError).code).toBe("no-credentials");
    }
  });

  test("ANTHROPIC_API_KEY in env stores the var NAME and never the value", () => {
    using fs = sandbox();
    const secret = "sk-ant-api03-SUPER-SECRET-VALUE";
    const result = save(fs, "ci", { ANTHROPIC_API_KEY: secret });

    expect(result.profile.kind).toBe("api-key");
    expect(result.profile.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(result.profile.credentials).toBeUndefined();
    const onDisk = readFileSync(join(fs.profilesDir, "ci.json"), "utf-8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).not.toContain(ACCESS_TOKEN);
    expect(onDisk).not.toContain(REFRESH_TOKEN);
  });

  test("api-key save does not claim the live oauth credentials or the active pointer", () => {
    using fs = sandbox();
    const result = save(fs, "ci", { ANTHROPIC_API_KEY: "x" });

    expect(result.becameActive).toBe(false);
    expect(readActiveProfileName(fs)).toBeNull();
    expect(result.warnings.join(" ")).toContain("NOT captured");
  });

  test("--api-key-env forces an api-key profile even when the var is unset", () => {
    using fs = sandbox();
    const result = save(fs, "ci", {}, "MY_KEY");

    expect(result.profile.kind).toBe("api-key");
    expect(result.profile.apiKeyEnvVar).toBe("MY_KEY");
    expect(result.warnings.join(" ")).toContain("MY_KEY is not set");
  });

  test("rejects path-traversal and empty profile names", () => {
    using fs = sandbox();
    for (const bad of ["../escape", "a/b", "", ".hidden"]) {
      expect(() => save(fs, bad)).toThrow(AuthProfileError);
    }
  });
});

const SAMPLE_STORED_QUOTA = {
  capturedAt: NOW.toISOString(),
  fiveHour: { utilization: 42, resetsAt: "2026-08-18T20:00:01.000Z" },
  sevenDay: { utilization: 8, resetsAt: "2026-08-25T04:00:00.000Z" },
  sevenDaySonnet: null,
  sevenDayOpus: null,
  extraUsage: null,
};

describe("saveProfile quota snapshot", () => {
  test("stores a provided quota on oauth profiles", () => {
    using fs = sandbox();
    const result = saveProfile({
      paths: fs,
      name: "work",
      env: {},
      now: NOW,
      platform: "linux",
      quota: SAMPLE_STORED_QUOTA,
    });
    expect(result.profile.quota).toEqual(SAMPLE_STORED_QUOTA);
    expect(JSON.parse(readFileSync(join(fs.profilesDir, "work.json"), "utf-8")).quota).toEqual(SAMPLE_STORED_QUOTA);
  });

  test("keeps the previous snapshot when a later save omits quota", () => {
    using fs = sandbox();
    saveProfile({
      paths: fs,
      name: "work",
      env: {},
      now: NOW,
      platform: "linux",
      quota: SAMPLE_STORED_QUOTA,
    });
    const later = new Date(NOW.getTime() + 60_000);
    const second = saveProfile({ paths: fs, name: "work", env: {}, now: later, platform: "linux" });
    expect(second.profile.quota).toEqual(SAMPLE_STORED_QUOTA);
  });

  test("replaces the snapshot when a new one is provided", () => {
    using fs = sandbox();
    saveProfile({
      paths: fs,
      name: "work",
      env: {},
      now: NOW,
      platform: "linux",
      quota: SAMPLE_STORED_QUOTA,
    });
    const next = { ...SAMPLE_STORED_QUOTA, fiveHour: { utilization: 90, resetsAt: "2026-08-18T21:00:00.000Z" } };
    const later = new Date(NOW.getTime() + 60_000);
    const second = saveProfile({
      paths: fs,
      name: "work",
      env: {},
      now: later,
      platform: "linux",
      quota: next,
    });
    expect(second.profile.quota?.fiveHour?.utilization).toBe(90);
  });

  test("api-key profiles never store quota", () => {
    using fs = sandbox();
    const result = saveProfile({
      paths: fs,
      name: "ci",
      env: {},
      now: NOW,
      platform: "linux",
      apiKeyEnvVar: "MY_KEY",
      quota: SAMPLE_STORED_QUOTA,
    });
    expect(result.profile.quota).toBeUndefined();
    expect(JSON.parse(readFileSync(join(fs.profilesDir, "ci.json"), "utf-8")).quota).toBeUndefined();
  });
});

describe("loadProfile quota write-back", () => {
  test("attaches outgoingQuota even when credentials did not change", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "other" })), { mode: 0o600 });
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-b", oauthAccount: oauthAccount("b@x.com") }), {
      mode: 0o600,
    });
    save(fs, "personal");

    const result = loadProfile({
      paths: fs,
      name: "work",
      env: {},
      now: NOW,
      platform: "linux",
      outgoingQuota: SAMPLE_STORED_QUOTA,
    });
    expect(result.wroteBack).toBe("personal");
    expect(result.wroteBackChanged).toBe(false);
    expect(readProfile(fs, "personal")?.quota).toEqual(SAMPLE_STORED_QUOTA);
  });
});

describe("stampActiveProfileQuota", () => {
  test("writes quota onto the active oauth profile without touching credentials or updatedAt", () => {
    using fs = sandbox();
    save(fs, "work");
    const before = readProfile(fs, "work");
    expect(before).not.toBeNull();

    expect(stampActiveProfileQuota(fs, SAMPLE_STORED_QUOTA, readLiveState(fs, NOW))).toMatchObject({ stamped: true });

    const after = readProfile(fs, "work");
    expect(after?.quota).toEqual(SAMPLE_STORED_QUOTA);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.credentials).toEqual(before?.credentials);
  });

  test("returns false when there is no active pointer", () => {
    using fs = sandbox();
    expect(stampActiveProfileQuota(fs, SAMPLE_STORED_QUOTA, readLiveState(fs, NOW))).toMatchObject({ stamped: false });
    expect(existsSync(fs.profilesDir)).toBe(false);
  });

  test("returns false during an in-flight switch and leaves the profile untouched", () => {
    using fs = sandbox();
    save(fs, "work");
    const pointerPath = join(fs.profilesDir, "active.json");
    const pointer = JSON.parse(readFileSync(pointerPath, "utf-8"));
    writeFileSync(pointerPath, JSON.stringify({ ...pointer, pending: "other" }));

    expect(stampActiveProfileQuota(fs, SAMPLE_STORED_QUOTA, readLiveState(fs, NOW))).toMatchObject({
      stamped: false,
    });
    expect(readProfile(fs, "work")?.quota).toBeUndefined();
  });

  test("does not stamp an inactive profile", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "other" })), { mode: 0o600 });
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-b", oauthAccount: oauthAccount("b@x.com") }), {
      mode: 0o600,
    });
    save(fs, "personal");

    expect(stampActiveProfileQuota(fs, SAMPLE_STORED_QUOTA, readLiveState(fs, NOW))).toMatchObject({ stamped: true });
    expect(readProfile(fs, "personal")?.quota).toEqual(SAMPLE_STORED_QUOTA);
    expect(readProfile(fs, "work")?.quota).toBeUndefined();
  });

  test("stampProfileQuota writes a named oauth profile that is not active", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "other" })), { mode: 0o600 });
    save(fs, "personal");

    expect(stampProfileQuota(fs, "work", SAMPLE_STORED_QUOTA)).toMatchObject({ stamped: true });
    expect(readProfile(fs, "work")?.quota).toEqual(SAMPLE_STORED_QUOTA);
    expect(readProfile(fs, "personal")?.quota).toBeUndefined();
  });
});

const LIVE_QUOTA_STATUS = {
  fiveHour: { utilization: 55, resetsAt: "2026-08-18T21:00:00.000Z" },
  sevenDay: { utilization: 12, resetsAt: "2026-08-25T04:00:00.000Z" },
  sevenDaySonnet: null,
  sevenDayOpus: null,
  extraUsage: null,
  fetchedAt: NOW.getTime(),
};

describe("fetchUnexpiredProfileQuotas", () => {
  test("isOauthTokenExpired is true only after expiresAt", () => {
    expect(isOauthTokenExpired(credentials(), NOW)).toBe(false);
    expect(isOauthTokenExpired(credentials({ expiresAt: NOW.getTime() }), NOW)).toBe(true);
    expect(isOauthTokenExpired(credentials({ expiresAt: NOW.getTime() - 1 }), NOW)).toBe(true);
    expect(isOauthTokenExpired({}, NOW)).toBeNull();
  });

  test("fetches unexpired profiles and skips expired ones", async () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "tok-personal" })), { mode: 0o600 });
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-b", oauthAccount: oauthAccount("b@x.com") }), {
      mode: 0o600,
    });
    save(fs, "personal");
    writeFileSync(
      fs.credentialsPath,
      JSON.stringify(credentials({ accessToken: "tok-stale", expiresAt: NOW.getTime() - 1 })),
      { mode: 0o600 },
    );
    save(fs, "stale");

    const seen: string[] = [];
    const result = await fetchUnexpiredProfileQuotas(fs, NOW, async (token) => {
      seen.push(token.accessToken);
      return LIVE_QUOTA_STATUS;
    });

    expect(seen.sort()).toEqual(["tok-personal", ACCESS_TOKEN].sort());
    expect(seen).not.toContain("tok-stale");
    expect(result.skippedExpired).toEqual(["stale"]);
    expect(result.skippedRateLimited).toEqual([]);
    expect(result.fetched.map((f) => f.name).sort()).toEqual(["personal", "work"]);
    expect(result.warnings).toEqual([]);
  });

  test("overlays live credentials onto the owning profile when the stored token is expired", async () => {
    using fs = sandbox();
    writeFileSync(
      fs.credentialsPath,
      JSON.stringify(credentials({ accessToken: "stored-dead", expiresAt: NOW.getTime() - 1 })),
      { mode: 0o600 },
    );
    save(fs, "ozone");
    // Claude refreshed the token in place: same account, new blob.
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "live-fresh" })), { mode: 0o600 });

    const seen: string[] = [];
    const result = await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async (token) => {
        seen.push(token.accessToken);
        return LIVE_QUOTA_STATUS;
      },
      { live: readLiveState(fs, NOW) },
    );

    expect(seen).toEqual(["live-fresh"]);
    expect(result.skippedExpired).toEqual([]);
    expect(result.overlaidProfile).toBe("ozone");
    expect(result.fetched.map((f) => f.name)).toEqual(["ozone"]);
  });

  test("refuses to overlay when the live blob cannot be attributed to the pointer's profile", async () => {
    using fs = sandbox();
    save(fs, "work");
    // A `claude /login` behind mcx's back: different account, different token.
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "tok-ROGUE" })), { mode: 0o600 });
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-z", oauthAccount: oauthAccount("z@evil.com") }), {
      mode: 0o600,
    });

    const seen: string[] = [];
    const result = await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async (token) => {
        seen.push(token.accessToken);
        return LIVE_QUOTA_STATUS;
      },
      { live: readLiveState(fs, NOW) },
    );

    expect(seen).toEqual([ACCESS_TOKEN]);
    expect(seen).not.toContain("tok-ROGUE");
    expect(result.overlaidProfile).toBeNull();
  });

  test("a failed fetch on one profile does not block the others", async () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "tok-personal" })), { mode: 0o600 });
    save(fs, "personal");

    const result = await fetchUnexpiredProfileQuotas(fs, NOW, async (token) => {
      if (token.accessToken === ACCESS_TOKEN) throw new Error("timeout");
      return LIVE_QUOTA_STATUS;
    });

    expect(result.fetched.map((f) => f.name)).toEqual(["personal"]);
    expect(result.warnings).toEqual([{ name: "work", message: "could not snapshot quota: timeout" }]);
  });

  test("retries 429s using Retry-After without waiting on the clock", async () => {
    using fs = sandbox();
    save(fs, "work");

    let calls = 0;
    const sleeps: number[] = [];
    const result = await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async () => {
        calls++;
        if (calls < 3) throw new QuotaRateLimitError("Quota API returned 429: slow down", 2_000);
        return LIVE_QUOTA_STATUS;
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(calls).toBe(3);
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(result.fetched.map((f) => f.name)).toEqual(["work"]);
    expect(result.skippedRateLimited).toEqual([]);
  });

  test("exponential backoff when Retry-After is missing", async () => {
    using fs = sandbox();
    save(fs, "work");

    const sleeps: number[] = [];
    await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async () => {
        throw new QuotaRateLimitError("Quota API returned 429: rate_limit_error");
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(sleeps).toEqual([1_000, 2_000]);
  });

  test("gives up a 429'd profile, then walks the rest with retries disabled", async () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "tok-personal" })), { mode: 0o600 });
    save(fs, "personal");

    const seen: string[] = [];
    const result = await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async (token) => {
        seen.push(token.accessToken);
        throw new QuotaRateLimitError("Quota API returned 429: nope");
      },
      { sleep: async () => {} },
    );

    // personal exhausts its three attempts; work still gets one (never zero — a
    // stable walk order otherwise starves every profile after the first, forever).
    expect(seen).toEqual(["tok-personal", "tok-personal", "tok-personal", ACCESS_TOKEN]);
    expect(result.fetched).toEqual([]);
    expect(result.skippedRateLimited).toEqual(["personal", "work"]);
    expect(result.warnings[0]?.name).toBe("personal");
    expect(result.warnings[0]?.message).toContain("rate-limited");
  });
});

describe("quota stamps are attributed (#3424)", () => {
  test("refuses to stamp when the live blob belongs to nobody we can prove", () => {
    using fs = sandbox();
    save(fs, "work");
    // `claude /login` behind mcx's back: the pointer still says "work".
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "tok-ROGUE" })), { mode: 0o600 });
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-z", oauthAccount: oauthAccount("z@evil.com") }), {
      mode: 0o600,
    });

    expect(stampActiveProfileQuota(fs, SAMPLE_STORED_QUOTA, readLiveState(fs, NOW))).toMatchObject({ stamped: false });
    expect(readProfile(fs, "work")?.quota).toBeUndefined();
  });

  test("stamps when Claude refreshed the token in place (same account, new blob)", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "refreshed" })), { mode: 0o600 });

    expect(stampActiveProfileQuota(fs, SAMPLE_STORED_QUOTA, readLiveState(fs, NOW))).toMatchObject({ stamped: true });
    expect(readProfile(fs, "work")?.quota).toEqual(SAMPLE_STORED_QUOTA);
  });

  test("stampProfileQuota refuses an api-key profile", () => {
    using fs = sandbox();
    save(fs, "key", { MY_KEY: "sk-secret" }, "MY_KEY");
    expect(stampProfileQuota(fs, "key", SAMPLE_STORED_QUOTA)).toMatchObject({ stamped: false });
    expect(readProfile(fs, "key")?.quota).toBeUndefined();
  });
});

describe("refreshProfileCredentialsFromLive (#3423)", () => {
  test("writes the refreshed live blob back onto the owning profile", () => {
    using fs = sandbox();
    save(fs, "work");
    const refreshed = credentials({ accessToken: "rotated", expiresAt: EXPIRES_AT + 8 * 3_600_000 });
    writeFileSync(fs.credentialsPath, JSON.stringify(refreshed), { mode: 0o600 });

    const later = new Date(NOW.getTime() + 60_000);
    expect(refreshProfileCredentialsFromLive(fs, readLiveState(fs, later), later)).toBe("work");
    expect(readProfile(fs, "work")?.credentials).toEqual(refreshed);
  });

  test("is a no-op when the stored copy already matches", () => {
    using fs = sandbox();
    save(fs, "work");
    expect(refreshProfileCredentialsFromLive(fs, readLiveState(fs, NOW), NOW)).toBeNull();
  });

  test("refuses to write back an unattributable blob", () => {
    using fs = sandbox();
    save(fs, "work");
    const before = readProfile(fs, "work")?.credentials;
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "tok-ROGUE" })), { mode: 0o600 });
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-z", oauthAccount: oauthAccount("z@evil.com") }), {
      mode: 0o600,
    });

    expect(refreshProfileCredentialsFromLive(fs, readLiveState(fs, NOW), NOW)).toBeNull();
    expect(readProfile(fs, "work")?.credentials).toEqual(before);
  });

  test("the stored token tracks the live one across more than one token lifetime", () => {
    using fs = sandbox();
    save(fs, "work");
    // Eight hourly ticks of the documented cron, Claude refreshing in place each time.
    for (let hour = 1; hour <= 10; hour++) {
      const tick = new Date(NOW.getTime() + hour * 3_600_000);
      writeFileSync(
        fs.credentialsPath,
        JSON.stringify(credentials({ accessToken: `tok-${hour}`, expiresAt: tick.getTime() + 8 * 3_600_000 })),
        { mode: 0o600 },
      );
      refreshProfileCredentialsFromLive(fs, readLiveState(fs, tick), tick);
    }
    const after = new Date(NOW.getTime() + 10 * 3_600_000);
    const summary = summarizeProfile(readProfile(fs, "work") as ClaudeAuthProfile, "work", after);
    expect(summary.expired).toBe(false);
    expect(isOauthTokenExpired(readProfile(fs, "work")?.credentials, after)).toBe(false);
  });
});

describe("stampProfileQuota bucket merge (#3427)", () => {
  const degraded = {
    capturedAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    fiveHour: null,
    sevenDay: { utilization: 30, resetsAt: "2026-08-25T04:00:00.000Z" },
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
  };

  test("a 200 that omits a bucket keeps the previous value and reports it", () => {
    using fs = sandbox();
    save(fs, "work");
    stampProfileQuota(fs, "work", SAMPLE_STORED_QUOTA);

    const result = stampProfileQuota(fs, "work", degraded);
    expect(result.keptBuckets).toEqual(["fiveHour"]);
    const after = readProfile(fs, "work")?.quota;
    expect(after?.fiveHour).toEqual(SAMPLE_STORED_QUOTA.fiveHour);
    expect(after?.sevenDay).toEqual(degraded.sevenDay);
  });

  test("a carried-over bucket drags capturedAt back to the older stamp", () => {
    using fs = sandbox();
    save(fs, "work");
    stampProfileQuota(fs, "work", SAMPLE_STORED_QUOTA);
    stampProfileQuota(fs, "work", degraded);
    // Not the degraded response's own (newer) capturedAt: the snapshot is only as
    // fresh as its oldest constituent, and the picker reads that to decide trust.
    expect(readProfile(fs, "work")?.quota?.capturedAt).toBe(SAMPLE_STORED_QUOTA.capturedAt);
  });

  test("a complete response replaces everything and reports no kept buckets", () => {
    using fs = sandbox();
    save(fs, "work");
    stampProfileQuota(fs, "work", degraded);
    const result = stampProfileQuota(fs, "work", SAMPLE_STORED_QUOTA);
    expect(result.keptBuckets).toEqual([]);
    expect(readProfile(fs, "work")?.quota).toEqual(SAMPLE_STORED_QUOTA);
  });
});

describe("--fetch-all wall-clock budget (#3426)", () => {
  test("the 60s cap is applied at the sleep, not only when parsing Retry-After", async () => {
    using fs = sandbox();
    save(fs, "work");
    const sleeps: number[] = [];
    await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async () => {
        throw new QuotaRateLimitError("Quota API returned 429: slow down", 3_600_000);
      },
      { sleep: async (ms) => void sleeps.push(ms), budgetMs: 10 * 60_000 },
    );
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  test("an intermittently-429ing fleet cannot accumulate minutes of backoff", async () => {
    using fs = sandbox();
    for (let i = 0; i < 10; i++) {
      writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: `tok-${i}` })), { mode: 0o600 });
      save(fs, `p${i}`);
    }

    let clockMs = 0;
    const failures = new Map<string, number>();
    const sleeps: number[] = [];
    // Every profile 429s once and then succeeds: no profile ever exhausts its
    // retries, so the documented "abort the rest" bail can never fire. Before the
    // budget this drove 10 × 2 × 60s = 20 minutes of sleep and still exited 0.
    await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async (token) => {
        const seen = (failures.get(token.accessToken) ?? 0) + 1;
        failures.set(token.accessToken, seen);
        if (seen <= 1) throw new QuotaRateLimitError("Quota API returned 429: slow down", 60_000);
        return LIVE_QUOTA_STATUS;
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          clockMs += ms;
        },
        clock: () => clockMs,
        budgetMs: 150_000,
      },
    );

    // Never *past* the budget either: the last profile that would overshoot gives up
    // instead of sleeping. Before the deadline this was 10 × 60s with exit 0.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(150_000);
    expect(sleeps.length).toBeLessThan(10);
  });

  test("profiles past the wall-clock budget are reported, not silently dropped", async () => {
    using fs = sandbox();
    for (let i = 0; i < 6; i++) {
      writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: `tok-${i}` })), { mode: 0o600 });
      save(fs, `p${i}`);
    }

    let clockMs = 0;
    const result = await fetchUnexpiredProfileQuotas(
      fs,
      NOW,
      async () => {
        // Every request burns its full 5s timeout, as a wedged endpoint does.
        clockMs += 5_000;
        throw new Error("The operation timed out");
      },
      { sleep: async () => {}, clock: () => clockMs, budgetMs: 15_000 },
    );

    expect(result.skippedBudget.length).toBe(3);
    expect(result.warnings.length).toBe(3);
  });

  test("a profile with no access token is skipped without a fetch", async () => {
    using fs = sandbox();
    save(fs, "work");
    const path = join(fs.profilesDir, "work.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.credentials = { claudeAiOauth: { refreshToken: REFRESH_TOKEN, expiresAt: NOW.getTime() - 1 } };
    writeFileSync(path, JSON.stringify(raw, null, 2));

    let calls = 0;
    const result = await fetchUnexpiredProfileQuotas(fs, NOW, async () => {
      calls++;
      return LIVE_QUOTA_STATUS;
    });
    expect(calls).toBe(0);
    expect(result.fetched).toEqual([]);
    // Skipped as "has nothing to query with", not reported as an expired token —
    // it has no `expiresAt` at all, and "run a load to refresh it" is wrong advice.
    expect(result.skippedExpired).toEqual([]);
  });
});

describe("snapshotQuotaFromCredentials", () => {
  test("returns a stored snapshot on success", async () => {
    const snap = await snapshotQuotaFromCredentials(credentials(), NOW, async () => ({
      fiveHour: { utilization: 42, resetsAt: "2026-08-18T20:00:01.000Z" },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
      fetchedAt: 1,
    }));
    expect(snap.warning).toBeUndefined();
    expect(snap.quota?.capturedAt).toBe(NOW.toISOString());
    expect(snap.quota?.fiveHour?.utilization).toBe(42);
  });

  test("returns a warning and no quota on fetch failure", async () => {
    const snap = await snapshotQuotaFromCredentials(credentials(), NOW, async () => {
      throw new Error("timeout");
    });
    expect(snap.quota).toBeUndefined();
    expect(snap.warning).toBe("could not snapshot quota: timeout");
  });

  test("no-ops without an access token", async () => {
    let called = false;
    const snap = await snapshotQuotaFromCredentials({}, NOW, async () => {
      called = true;
      throw new Error("should not fetch");
    });
    expect(called).toBe(false);
    expect(snap).toEqual({});
  });
});

describe("summarizeProfile quota", () => {
  test("projects the snapshot without token material", () => {
    using fs = sandbox();
    const { profile } = saveProfile({
      paths: fs,
      name: "work",
      env: {},
      now: NOW,
      platform: "linux",
      quota: SAMPLE_STORED_QUOTA,
    });
    const summary = summarizeProfile(profile, "work", NOW);
    expect(summary.quota).toEqual(SAMPLE_STORED_QUOTA);
    expect(JSON.stringify(summary)).not.toContain(ACCESS_TOKEN);
  });
});

// ── load ──

describe("loadProfile", () => {
  test("swaps credentials and identity, preserving unrelated ~/.claude.json keys and mode", () => {
    using fs = sandbox();
    save(fs, "work");

    // Simulate logging in as someone else, then capture that identity too.
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "second-token" })), { mode: 0o600 });
    writeFileSync(
      fs.claudeConfigPath,
      JSON.stringify({ userID: "user-b", oauthAccount: oauthAccount("b@example.com"), projects: { "/repo": {} } }),
      { mode: 0o600 },
    );
    save(fs, "personal");

    const result = load(fs, "work");

    expect(result.credentialsWritten).toBe(true);
    expect(result.identityWritten).toBe(true);
    const liveCreds = JSON.parse(readFileSync(fs.credentialsPath, "utf-8"));
    expect(liveCreds).toEqual(credentials());
    const liveConfig = JSON.parse(readFileSync(fs.claudeConfigPath, "utf-8"));
    expect(liveConfig.userID).toBe("user-a");
    expect(liveConfig.projects).toEqual({ "/repo": {} }); // unrelated keys survive
    expect(mode(fs.credentialsPath)).toBe(0o600);
    expect(readActiveProfileName(fs)).toBe("work");
  });

  test("writes refreshed live credentials back to the previously active profile", () => {
    using fs = sandbox();
    save(fs, "work"); // work is active
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-b", oauthAccount: oauthAccount("b@x.com") }));
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "rotated" })));
    save(fs, "personal"); // personal becomes active

    // Claude refreshes the token in place while "personal" is active.
    const refreshed = credentials({ accessToken: "refreshed-token", expiresAt: EXPIRES_AT + 3_600_000 });
    writeFileSync(fs.credentialsPath, JSON.stringify(refreshed));

    const result = load(fs, "work");

    expect(result.wroteBack).toBe("personal");
    expect(result.wroteBackChanged).toBe(true);
    const stored = readProfile(fs, "personal");
    expect(stored?.credentials).toEqual(refreshed);
  });

  test("reports no change when the active profile's credentials are untouched", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "other" })));
    save(fs, "personal");

    const result = load(fs, "work");
    expect(result.wroteBack).toBe("personal");
    expect(result.wroteBackChanged).toBe(false);
  });

  test("invalidates the cached org policy", () => {
    using fs = sandbox();
    save(fs, "work");
    const result = load(fs, "work");

    expect(result.policyInvalidated).toBe(true);
    expect(existsSync(fs.policyLimitsPath)).toBe(false);
  });

  test("backs up the pre-existing files once, and never overwrites that backup", () => {
    using fs = sandbox();
    save(fs, "work");
    const first = load(fs, "work");

    expect(first.backupDir).not.toBeNull();
    const backupCreds = JSON.parse(readFileSync(join(first.backupDir as string, "credentials.json"), "utf-8"));
    expect(backupCreds).toEqual(credentials());
    expect(mode(first.backupDir as string)).toBe(0o700);
    expect(mode(join(first.backupDir as string, "credentials.json"))).toBe(0o600);

    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "newer" })));
    const second = load(fs, "work");
    expect(second.backupDir).toBeNull();
    const stillOriginal = JSON.parse(readFileSync(join(first.backupDir as string, "credentials.json"), "utf-8"));
    expect(stillOriginal).toEqual(credentials());
  });

  test("re-loading the active profile absorbs a refreshed token instead of reverting it", () => {
    using fs = sandbox();
    save(fs, "work");
    const refreshed = credentials({ accessToken: "refreshed-in-place" });
    writeFileSync(fs.credentialsPath, JSON.stringify(refreshed));

    const result = load(fs, "work");

    expect(result.wroteBack).toBe("work");
    expect(readProfile(fs, "work")?.credentials).toEqual(refreshed);
    expect(JSON.parse(readFileSync(fs.credentialsPath, "utf-8"))).toEqual(refreshed);
  });

  test("unknown active profile: backs up live credentials and warns, destroying nothing", () => {
    using fs = sandbox();
    // Profile saved from a different machine state — active pointer never written.
    const profile: ClaudeAuthProfile = {
      version: 1,
      name: "imported",
      kind: "oauth",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      credentials: credentials({ accessToken: "imported-token" }),
      identity: { userID: "user-c" },
    };
    mkdirSync(fs.profilesDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(fs.profilesDir, "imported.json"), JSON.stringify(profile), { mode: 0o600 });

    const result = load(fs, "imported");

    expect(result.previousActive).toBeNull();
    expect(result.backupDir).not.toBeNull();
    expect(result.warnings.join(" ")).toContain("no profile owned the credentials");
    const rescued = JSON.parse(readFileSync(join(result.backupDir as string, "credentials.json"), "utf-8"));
    expect(rescued).toEqual(credentials()); // the pre-switch identity is recoverable
  });

  test("dangling active pointer: no write-back, and the outgoing blob still exists on disk", () => {
    using fs = sandbox();
    save(fs, "work");
    save(fs, "other");
    load(fs, "work"); // consumes the one-time "original" backup, active = work
    const outgoing = readFileSync(fs.credentialsPath, "utf-8");
    rmSync(join(fs.profilesDir, "work.json"));

    const result = load(fs, "other");

    expect(result.wroteBack).toBeNull();
    expect(result.warnings.join(" ")).toContain("no longer exists");
    // "other" holds an identical copy already, so nothing had to be backed up — but the
    // bytes must still be findable somewhere in the store (invariant (a)).
    expect(result.outgoingPreservedAs).toBe("already-stored");
    expect(storeContainsCredentials(fs, outgoing)).toBe(true);
  });

  test("dangling active pointer whose credentials are unique: orphan backup keeps them", () => {
    using fs = sandbox();
    save(fs, "work");
    save(fs, "other");
    load(fs, "work");
    rmSync(join(fs.profilesDir, "work.json"));
    // Claude refreshes the token, so no profile holds this blob any more.
    const refreshed = credentials({ accessToken: "unique-after-refresh" });
    writeFileSync(fs.credentialsPath, JSON.stringify(refreshed));

    const result = load(fs, "other");

    expect(result.outgoingPreservedAs).toBe("backup");
    expect(result.orphanBackupDir).not.toBeNull();
    expect(JSON.parse(readFileSync(join(result.orphanBackupDir as string, "credentials.json"), "utf-8"))).toEqual(
      refreshed,
    );
  });

  test("api-key profile leaves credentials untouched and warns about the env var", () => {
    using fs = sandbox();
    save(fs, "ci", {}, "MY_KEY");
    const before = readFileSync(fs.credentialsPath, "utf-8");

    const result = load(fs, "ci");

    expect(result.credentialsWritten).toBe(false);
    expect(readFileSync(fs.credentialsPath, "utf-8")).toBe(before);
    expect(result.warnings.join(" ")).toContain("export MY_KEY");
    expect(result.warnings.join(" ")).toContain("MY_KEY is not set");
  });

  test("api-key profile with the env var set does not warn about it being unset", () => {
    using fs = sandbox();
    save(fs, "ci", {}, "MY_KEY");
    const result = load(fs, "ci", { MY_KEY: "value" });
    expect(result.warnings.join(" ")).not.toContain("MY_KEY is not set");
  });

  test("switching away from an api-key profile does not fabricate a write-back", () => {
    using fs = sandbox();
    save(fs, "work");
    save(fs, "ci", { ANTHROPIC_API_KEY: "x" });
    load(fs, "ci");

    const result = load(fs, "work");
    // An api-key profile stores no tokens, so it can never be the owner of the live blob.
    expect(result.previousActive).toBeNull();
    expect(result.wroteBack).toBeNull();
  });

  test("throws not-found for an unknown profile", () => {
    using fs = sandbox();
    try {
      load(fs, "nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthProfileError);
      expect((err as AuthProfileError).code).toBe("not-found");
    }
  });

  test("profile without identity keys skips the ~/.claude.json patch", () => {
    using fs = sandbox({ claudeConfig: null });
    save(fs, "work");
    const result = load(fs, "work");

    expect(result.identityWritten).toBe(false);
    expect(result.credentialsWritten).toBe(true);
  });
});

// ── ~/.claude.json surgery ──

describe("patchClaudeConfigIdentity", () => {
  test("rewrites only the identity keys and preserves the file mode", () => {
    using fs = sandbox();
    chmodSync(fs.claudeConfigPath, 0o644);

    patchClaudeConfigIdentity(fs.claudeConfigPath, { userID: "user-z", oauthAccount: oauthAccount("z@x.com") });

    const config = JSON.parse(readFileSync(fs.claudeConfigPath, "utf-8"));
    expect(config.userID).toBe("user-z");
    expect(config.oauthAccount.emailAddress).toBe("z@x.com");
    expect(config.projects).toEqual({ "/repo": { allowedTools: [] } });
    expect(mode(fs.claudeConfigPath)).toBe(0o644);
  });

  test("removes identity keys when the profile carries none", () => {
    using fs = sandbox();
    patchClaudeConfigIdentity(fs.claudeConfigPath, {});
    const config = JSON.parse(readFileSync(fs.claudeConfigPath, "utf-8"));
    expect("userID" in config).toBe(false);
    expect("oauthAccount" in config).toBe(false);
    expect(config.projects).toBeDefined();
  });

  test("creates the file when it is missing", () => {
    using fs = sandbox({ claudeConfig: null });
    patchClaudeConfigIdentity(fs.claudeConfigPath, { userID: "fresh" });
    expect(JSON.parse(readFileSync(fs.claudeConfigPath, "utf-8")).userID).toBe("fresh");
  });

  test("refuses to touch a config that is not valid JSON", () => {
    using fs = sandbox();
    writeFileSync(fs.claudeConfigPath, "{ not json");
    try {
      patchClaudeConfigIdentity(fs.claudeConfigPath, { userID: "x" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthProfileError);
      expect((err as AuthProfileError).code).toBe("config-unreadable");
    }
    expect(readFileSync(fs.claudeConfigPath, "utf-8")).toBe("{ not json");
  });
});

// ── Atomic write ──

describe("writeFileAtomic", () => {
  test("writes 0600 and leaves no temp file behind", () => {
    using fs = sandbox();
    const target = join(fs.root, "out.json");
    writeFileAtomic(target, '{"a":1}\n');

    expect(readFileSync(target, "utf-8")).toBe('{"a":1}\n');
    expect(mode(target)).toBe(0o600);
    expect(readdirSync(fs.root).sort()).toEqual([".claude", ".claude.json", "out.json"]);
  });
});

// ── Platform split ──

describe("assertPlatformSupported", () => {
  test("linux is supported", () => {
    expect(() => assertPlatformSupported("linux")).not.toThrow();
  });

  test("darwin fails with a keychain-specific unsupported-platform error", () => {
    try {
      assertPlatformSupported("darwin");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthProfileError);
      expect((err as AuthProfileError).code).toBe("unsupported-platform");
      expect((err as AuthProfileError).message).toContain("Keychain");
    }
  });

  test("other platforms fail too", () => {
    expect(() => assertPlatformSupported("win32")).toThrow(AuthProfileError);
  });

  test("save and load refuse to run on darwin", () => {
    using fs = sandbox();
    expect(() => saveProfile({ paths: fs, name: "work", env: {}, now: NOW, platform: "darwin" })).toThrow(
      AuthProfileError,
    );
    expect(() => loadProfile({ paths: fs, name: "work", env: {}, now: NOW, platform: "darwin" })).toThrow(
      AuthProfileError,
    );
    expect(existsSync(fs.profilesDir)).toBe(false);
  });
});

// ── Summaries ──

describe("summarizeProfile / listProfiles", () => {
  test("summary carries account + expiry but no token material", () => {
    using fs = sandbox();
    const { profile } = save(fs, "work");
    const summary = summarizeProfile(profile, "work", NOW);

    expect(summary).toMatchObject({
      name: "work",
      kind: "oauth",
      active: true,
      account: "a@example.com",
      organization: "Acme",
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      allowRemoteControl: false,
      hasCredentials: true,
    });
    expect(summary.expiresAt).toBe(new Date(EXPIRES_AT).toISOString());
    expect(summary.expired).toBe(false);
    expect(summary.quota).toBeNull();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
  });

  test("marks an expired access token", () => {
    using fs = sandbox();
    const { profile } = save(fs, "work");
    const later = new Date(EXPIRES_AT + 1000);
    expect(summarizeProfile(profile, null, later).expired).toBe(true);
  });

  test("api-key summary exposes the env var name and no credentials", () => {
    using fs = sandbox();
    const { profile } = save(fs, "ci", {}, "MY_KEY");
    const summary = summarizeProfile(profile, null, NOW);

    expect(summary.apiKeyEnvVar).toBe("MY_KEY");
    expect(summary.hasCredentials).toBe(false);
    expect(summary.account).toBeNull();
    expect(summary.quota).toBeNull();
  });

  test("lists profiles sorted with the active one flagged", () => {
    using fs = sandbox();
    save(fs, "zeta");
    save(fs, "alpha");

    const { profiles, problems } = listProfiles(fs, NOW);
    expect(profiles.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(profiles.map((s) => s.active)).toEqual([true, false]);
    expect(problems).toEqual([]);
  });

  test("returns an empty list when nothing has been saved", () => {
    using fs = sandbox();
    expect(listProfiles(fs, NOW)).toEqual({ profiles: [], problems: [] });
  });
});

// ── Path resolution (CLAUDE_CONFIG_DIR) ──

describe("defaultAuthPaths", () => {
  test("falls back to the home-relative layout when CLAUDE_CONFIG_DIR is unset", () => {
    using opts = testOptions();
    const paths = defaultAuthPaths({});

    expect(paths.credentialsPath).toBe(opts.CLAUDE_CREDENTIALS_PATH);
    expect(paths.claudeConfigPath).toBe(opts.CLAUDE_CONFIG_PATH);
    expect(paths.policyLimitsPath).toBe(opts.CLAUDE_POLICY_LIMITS_PATH);
    expect(paths.profilesDir).toBe(opts.AUTH_PROFILES_DIR);
  });

  test("CLAUDE_CONFIG_DIR relocates all three files into that directory", () => {
    using opts = testOptions();
    const cfg = join(opts.dir, "cfgdir");
    const paths = defaultAuthPaths({ CLAUDE_CONFIG_DIR: cfg });

    // Under a redirected config dir .claude.json sits INSIDE it, unlike the default layout.
    expect(paths.credentialsPath).toBe(join(cfg, ".credentials.json"));
    expect(paths.claudeConfigPath).toBe(join(cfg, ".claude.json"));
    expect(paths.policyLimitsPath).toBe(join(cfg, "policy-limits.json"));
  });

  test("an empty CLAUDE_CONFIG_DIR is ignored", () => {
    using opts = testOptions();
    expect(defaultAuthPaths({ CLAUDE_CONFIG_DIR: "  " }).credentialsPath).toBe(opts.CLAUDE_CREDENTIALS_PATH);
  });

  test("CLAUDE_SECURESTORAGE_CONFIG_DIR overrides only the credentials location", () => {
    using opts = testOptions();
    const cfg = join(opts.dir, "cfgdir");
    const secure = join(opts.dir, "securedir");
    const paths = defaultAuthPaths({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure });

    expect(paths.credentialsPath).toBe(join(secure, ".credentials.json"));
    expect(paths.claudeConfigPath).toBe(join(cfg, ".claude.json"));
  });

  test("an existing .config.json in the config dir supersedes .claude.json", () => {
    using opts = testOptions();
    const cfg = join(opts.dir, "cfgdir");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, ".config.json"), "{}");

    expect(defaultAuthPaths({ CLAUDE_CONFIG_DIR: cfg }).claudeConfigPath).toBe(join(cfg, ".config.json"));
  });

  test("an active pointer from another config dir does not trigger a bogus write-back", () => {
    using opts = testOptions();
    const cfgA = join(opts.dir, "cfgA");
    const cfgB = join(opts.dir, "cfgB");
    mkdirSync(cfgA, { recursive: true });
    mkdirSync(cfgB, { recursive: true });
    const pathsA = defaultAuthPaths({ CLAUDE_CONFIG_DIR: cfgA });
    const pathsB = defaultAuthPaths({ CLAUDE_CONFIG_DIR: cfgB });

    writeFileSync(pathsA.credentialsPath, JSON.stringify(credentials()), { mode: 0o600 });
    save(pathsA, "alpha"); // active pointer now describes cfgA

    // A different identity lives in cfgB; loading alpha there must not claim it for alpha.
    writeFileSync(pathsB.credentialsPath, JSON.stringify(credentials({ accessToken: "cfgB-token" })), { mode: 0o600 });
    const result = load(pathsB, "alpha");

    expect(result.previousActive).toBeNull();
    expect(result.wroteBack).toBeNull();
    expect(result.warnings.join(" ")).toContain("was recorded for");
    expect(readProfile(pathsA, "alpha")?.credentials).toEqual(credentials());
  });

  test("save/load round-trip works against a CLAUDE_CONFIG_DIR layout", () => {
    using opts = testOptions();
    const cfg = join(opts.dir, "cfgdir");
    mkdirSync(cfg, { recursive: true });
    const paths = defaultAuthPaths({ CLAUDE_CONFIG_DIR: cfg });
    writeFileSync(paths.credentialsPath, JSON.stringify(credentials()), { mode: 0o600 });
    writeFileSync(paths.claudeConfigPath, JSON.stringify({ userID: "cfg-user", keep: true }));

    save(paths, "cfg");
    writeFileSync(paths.credentialsPath, JSON.stringify(credentials({ accessToken: "elsewhere" })));
    save(paths, "other"); // "other" owns the second identity and becomes active
    const result = load(paths, "cfg");

    expect(result.credentialsWritten).toBe(true);
    expect(result.wroteBack).toBe("other");
    expect(JSON.parse(readFileSync(paths.credentialsPath, "utf-8"))).toEqual(credentials());
    expect(JSON.parse(readFileSync(paths.claudeConfigPath, "utf-8")).keep).toBe(true);
  });
});

// ── --oauth override ──

describe("saveProfile forceOauth", () => {
  test("captures the oauth identity even when ANTHROPIC_API_KEY is exported", () => {
    using fs = sandbox();
    const result = saveProfile({
      paths: fs,
      name: "work",
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-SECRET" },
      now: NOW,
      platform: "linux",
      forceOauth: true,
    });

    expect(result.profile.kind).toBe("oauth");
    expect(result.profile.credentials).toEqual(credentials());
    expect(readFileSync(join(fs.profilesDir, "work.json"), "utf-8")).not.toContain("sk-ant-api03-SECRET");
  });
});

// ── QA regressions: the outgoing blob must always survive (invariant (a)) ──

describe("loadProfile — invariant (a): outgoing credentials always survive", () => {
  test("P1-1: a token refreshed while an api-key profile is active is not destroyed", () => {
    using fs = sandbox();
    save(fs, "work"); // oauth, owns the live credentials
    save(fs, "ci", {}, "MY_KEY"); // api-key profile, stores no tokens
    load(fs, "ci"); // pointer moves to "ci"; credentials deliberately left alone

    // Claude refreshes the token in place while "ci" is the recorded active profile.
    const refreshed = credentials({ accessToken: "refreshed-under-api-key", refreshToken: "rt-REFRESHED" });
    const refreshedRaw = JSON.stringify(refreshed);
    writeFileSync(fs.credentialsPath, refreshedRaw);

    const result = load(fs, "work");

    // Before the fix the api-key pointer short-circuited the write-back with no backup,
    // and the very next line overwrote .credentials.json — the refresh token was gone.
    expect(result.credentialsWritten).toBe(true);
    expect(storeContainsCredentials(fs, refreshedRaw)).toBe(true);
    expect(result.outgoingPreservedAs).toBe("backup");
    expect(result.warnings.join(" ")).toContain("api-key profile");
  });

  test("credentials belonging to an unknown account are backed up, never assumed", () => {
    using fs = sandbox();
    save(fs, "work");
    // Someone logs in as a different account outside mcx.
    const foreign = credentials({ accessToken: "foreign-token" });
    const foreignRaw = JSON.stringify(foreign);
    writeFileSync(fs.credentialsPath, foreignRaw);
    writeFileSync(
      fs.claudeConfigPath,
      JSON.stringify({ userID: "user-foreign", oauthAccount: oauthAccount("foreign@example.com") }),
    );

    const result = load(fs, "work");

    expect(result.wroteBack).toBeNull();
    expect(result.outgoingPreservedAs).toBe("backup");
    expect(storeContainsCredentials(fs, foreignRaw)).toBe(true);
    // The foreign blob must not have been filed under "work".
    expect(readProfile(fs, "work")?.credentials).toEqual(credentials());
  });

  test("a refresh of the same account is still written back to its profile", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "second-identity" })));
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-b", oauthAccount: oauthAccount("b@x.com") }));
    save(fs, "personal");

    // Same account as "personal" (identity untouched), new token bytes.
    const refreshed = credentials({ accessToken: "personal-refreshed" });
    writeFileSync(fs.credentialsPath, JSON.stringify(refreshed));

    const result = load(fs, "work");

    expect(result.wroteBack).toBe("personal");
    expect(result.outgoingPreservedAs).toBe("write-back");
    expect(readProfile(fs, "personal")?.credentials).toEqual(refreshed);
  });
});

// ── QA regressions: all-or-nothing switch (invariant (f)) ──

describe("loadProfile — torn-state protection", () => {
  test("P1-2: a locked ~/.claude.json aborts before .credentials.json is touched", () => {
    using fs = sandbox();
    save(fs, "one");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "two-token" })));
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-two", oauthAccount: oauthAccount("two@x.com") }));
    save(fs, "two"); // active = two

    const liveBefore = readFileSync(fs.credentialsPath, "utf-8");
    const configBefore = readFileSync(fs.claudeConfigPath, "utf-8");

    // flock(2) conflicts between distinct file descriptions, even inside one process.
    const fd = openSync(fs.claudeConfigPath, "a+");
    expect(tryFlockExclusive(fd)).toBe(true);
    try {
      expectAuthError(
        () => loadProfile({ paths: fs, name: "one", env: {}, now: NOW, platform: "linux", lockDeadlineMs: 50 }),
        "config-locked",
      );

      // Nothing may have been mutated: no half-switched identity.
      expect(readFileSync(fs.credentialsPath, "utf-8")).toBe(liveBefore);
      expect(readFileSync(fs.claudeConfigPath, "utf-8")).toBe(configBefore);
      const pointer = readActivePointer(fs);
      expect(pointer?.name).toBe("two");
      expect(pointer?.pending).toBeNull();
    } finally {
      flockUnlock(fd);
      closeSync(fd);
    }
  });

  test("P1-2: an interrupted switch is not trusted on the next load", () => {
    using fs = sandbox();
    save(fs, "one");
    const oneCredentials = readProfile(fs, "one")?.credentials;

    // Simulate a crash mid-switch: pointer still names "one" (with its fingerprint) and
    // carries the pending marker, while the live blob is already somebody else's.
    const pointerPath = join(fs.profilesDir, "active.json");
    const pointer = JSON.parse(readFileSync(pointerPath, "utf-8"));
    writeFileSync(pointerPath, JSON.stringify({ ...pointer, pending: "two" }));
    const strangerRaw = JSON.stringify(credentials({ accessToken: "mid-switch-token" }));
    writeFileSync(fs.credentialsPath, strangerRaw);

    // A third profile to switch into, created without disturbing the pointer.
    writeFileSync(
      join(fs.profilesDir, "three.json"),
      JSON.stringify({
        version: 1,
        name: "three",
        kind: "oauth",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        credentials: credentials({ accessToken: "three-token" }),
        identity: { userID: "user-three" },
      }),
      { mode: 0o600 },
    );

    const result = load(fs, "three");

    expect(result.wroteBack).toBeNull();
    expect(result.warnings.join(" ")).toContain("interrupted");
    // "one" must not have been contaminated with the mid-switch blob.
    expect(readProfile(fs, "one")?.credentials).toEqual(oneCredentials);
    expect(storeContainsCredentials(fs, strangerRaw)).toBe(true);
  });

  test("a second concurrent auth operation is refused rather than interleaved", () => {
    using fs = sandbox();
    save(fs, "work");
    const liveBefore = readFileSync(fs.credentialsPath, "utf-8");

    const fd = openSync(join(fs.profilesDir, ".operation.lock"), "a+");
    expect(tryFlockExclusive(fd)).toBe(true);
    try {
      expectAuthError(
        () => loadProfile({ paths: fs, name: "work", env: {}, now: NOW, platform: "linux", lockDeadlineMs: 50 }),
        "config-locked",
      );
      expect(readFileSync(fs.credentialsPath, "utf-8")).toBe(liveBefore);
    } finally {
      flockUnlock(fd);
      closeSync(fd);
    }
  });
});

// ── QA regressions: api-key profiles hold no secrets (invariant (b)) ──

describe("api-key profiles never hold credentials", () => {
  test("P1-3: re-loading an api-key profile does not absorb the live OAuth tokens", () => {
    using fs = sandbox();
    save(fs, "ci", {}, "MY_KEY");
    load(fs, "ci");
    load(fs, "ci"); // second load previously hit the "refreshed" branch

    const raw = readFileSync(join(fs.profilesDir, "ci.json"), "utf-8");
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(REFRESH_TOKEN);
    const profile = readProfile(fs, "ci");
    expect(profile?.credentials).toBeUndefined();
    expect(profile?.identity).toBeUndefined();
  });

  test("writeProfile strips credentials and identity from an api-key record", () => {
    using fs = sandbox();
    writeProfile(fs, {
      version: 1,
      name: "ci",
      kind: "api-key",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      apiKeyEnvVar: "MY_KEY",
      credentials: credentials(),
      identity: { userID: "user-a" },
      quota: SAMPLE_STORED_QUOTA,
    });

    const raw = readFileSync(join(fs.profilesDir, "ci.json"), "utf-8");
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      name: "ci",
      kind: "api-key",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      apiKeyEnvVar: "MY_KEY",
    });
  });
});

// ── QA regressions: permissions, IO errors, corrupt files ──

describe("loadProfile — file hygiene", () => {
  test("a ~/.claude.json created by the switch is 0600, not 0664", () => {
    using fs = sandbox({ claudeConfig: null });
    save(fs, "work"); // owns the live credentials; no ~/.claude.json exists yet
    writeFileSync(
      join(fs.profilesDir, "other.json"),
      JSON.stringify({
        version: 1,
        name: "other",
        kind: "oauth",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        credentials: credentials({ accessToken: "other-token" }),
        identity: { userID: "user-a", oauthAccount: oauthAccount("a@example.com") },
      }),
      { mode: 0o600 },
    );

    const result = load(fs, "other");

    expect(result.identityWritten).toBe(true);
    expect(mode(fs.claudeConfigPath)).toBe(0o600);
    expect(mode(fs.credentialsPath)).toBe(0o600);
  });

  test("a missing credentials directory is created rather than throwing ENOENT", () => {
    using fs = sandbox();
    save(fs, "work");
    rmSync(fs.credentialsPath);
    rmSync(join(fs.root, ".claude"), { recursive: true });

    const result = load(fs, "work");

    expect(result.credentialsWritten).toBe(true);
    expect(JSON.parse(readFileSync(fs.credentialsPath, "utf-8"))).toEqual(credentials());
  });

  test("an unusable credentials path surfaces as AuthProfileError, not a raw errno", () => {
    using fs = sandbox();
    save(fs, "work");
    // A regular file where a directory is expected → ENOTDIR from the write.
    const blocker = join(fs.root, "blocker");
    writeFileSync(blocker, "not a directory");
    const brokenPaths = { ...fs, credentialsPath: join(blocker, ".credentials.json") };

    const error = expectAuthError(
      () => loadProfile({ paths: brokenPaths, name: "work", env: {}, now: NOW, platform: "linux" }),
      "io",
    );
    expect(error.message).toMatch(/: E[A-Z]+$/);
  });

  test("an unreadable credentials file surfaces as AuthProfileError, not a raw errno", () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits — nothing to assert
    using fs = sandbox();
    save(fs, "work");
    chmodSync(fs.credentialsPath, 0o000);

    try {
      expectAuthError(() => loadProfile({ paths: fs, name: "work", env: {}, now: NOW, platform: "linux" }), "io");
    } finally {
      chmodSync(fs.credentialsPath, 0o600);
    }
  });

  test("a symlinked credentials file keeps its link instead of being replaced", () => {
    using fs = sandbox();
    save(fs, "work");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "other" })));
    save(fs, "other");

    const realTarget = join(fs.root, "real-credentials.json");
    rmSync(fs.credentialsPath);
    writeFileSync(realTarget, JSON.stringify(credentials({ accessToken: "other" })), { mode: 0o600 });
    symlinkSync(realTarget, fs.credentialsPath);

    load(fs, "work");

    expect(lstatSync(fs.credentialsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(realTarget, "utf-8"))).toEqual(credentials());
  });
});

describe("listProfiles — one bad file must not hide the rest", () => {
  test("a corrupt profile is reported as a problem while healthy ones still list", () => {
    using fs = sandbox();
    save(fs, "good");
    writeFileSync(join(fs.profilesDir, "broken.json"), "{ not json", { mode: 0o600 });

    const { profiles, problems } = listProfiles(fs, NOW);

    expect(profiles.map((p) => p.name)).toEqual(["good"]);
    expect(problems.map((p) => p.name)).toEqual(["broken"]);
    expect(problems[0].message).toContain("not valid JSON");
  });
});

describe("loadProfile — rollback", () => {
  test("a failure after the credentials write restores the previous bytes and pointer", () => {
    using fs = sandbox();
    save(fs, "one");
    writeFileSync(fs.credentialsPath, JSON.stringify(credentials({ accessToken: "two-token" })));
    writeFileSync(fs.claudeConfigPath, JSON.stringify({ userID: "user-two", oauthAccount: oauthAccount("two@x.com") }));
    save(fs, "two"); // active = two

    const liveBefore = readFileSync(fs.credentialsPath, "utf-8");
    const configBefore = readFileSync(fs.claudeConfigPath, "utf-8");

    expect(() =>
      loadProfile({
        paths: fs,
        name: "one",
        env: {},
        now: NOW,
        platform: "linux",
        hooks: {
          onAfterCredentialsWrite: () => {
            throw new Error("simulated crash between credential and identity writes");
          },
        },
      }),
    ).toThrow("simulated crash");

    expect(readFileSync(fs.credentialsPath, "utf-8")).toBe(liveBefore);
    expect(readFileSync(fs.claudeConfigPath, "utf-8")).toBe(configBefore);
    const pointer = readActivePointer(fs);
    expect(pointer?.name).toBe("two");
    expect(pointer?.pending).toBeNull();
  });

  test("a failed lock acquisition does not leave an empty config file behind", () => {
    using fs = sandbox({ claudeConfig: null });
    expect(existsSync(fs.claudeConfigPath)).toBe(false);

    expect(() =>
      withExclusiveLock(
        fs.claudeConfigPath,
        () => {
          throw new AuthProfileError("boom", "io");
        },
        50,
      ),
    ).toThrow(AuthProfileError);

    expect(existsSync(fs.claudeConfigPath)).toBe(false);
  });
});
