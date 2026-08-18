import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import {
  type AuthPaths,
  AuthProfileError,
  type ClaudeAuthProfile,
  assertPlatformSupported,
  defaultAuthPaths,
  listProfiles,
  loadProfile,
  patchClaudeConfigIdentity,
  readActiveProfileName,
  readProfile,
  saveProfile,
  summarizeProfile,
  writeFileAtomic,
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
    expect(result.warnings.join(" ")).toContain("no active profile was recorded");
    const rescued = JSON.parse(readFileSync(join(result.backupDir as string, "credentials.json"), "utf-8"));
    expect(rescued).toEqual(credentials()); // the pre-switch identity is recoverable
  });

  test("dangling active pointer: warns and keeps an orphan backup", () => {
    using fs = sandbox();
    save(fs, "work");
    save(fs, "other");
    load(fs, "work"); // consumes the one-time "original" backup, active = work
    rmSync(join(fs.profilesDir, "work.json"));

    const result = load(fs, "other");

    expect(result.wroteBack).toBeNull();
    expect(result.orphanBackupDir).not.toBeNull();
    expect(result.warnings.join(" ")).toContain("no longer exists");
    expect(existsSync(join(result.orphanBackupDir as string, "credentials.json"))).toBe(true);
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
    expect(result.previousActive).toBe("ci");
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
      allowRemoteControl: false,
      hasCredentials: true,
    });
    expect(summary.expiresAt).toBe(new Date(EXPIRES_AT).toISOString());
    expect(summary.expired).toBe(false);
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
  });

  test("lists profiles sorted with the active one flagged", () => {
    using fs = sandbox();
    save(fs, "zeta");
    save(fs, "alpha");

    const summaries = listProfiles(fs, NOW);
    expect(summaries.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(summaries.filter((s) => s.active).map((s) => s.name)).toEqual(["alpha"]);
  });

  test("returns an empty list when nothing has been saved", () => {
    using fs = sandbox();
    expect(listProfiles(fs, NOW)).toEqual([]);
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
