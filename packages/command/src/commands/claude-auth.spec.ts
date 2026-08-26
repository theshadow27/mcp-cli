import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuotaStatus } from "@mcp-cli/core";
import type { AuthPaths } from "../claude-auth-store";
import { ExitError } from "../test-helpers";
import { type AuthCliDeps, type AuthEnvDeps, claudeAuth, formatProfileTable } from "./claude-auth";

const ACCESS_TOKEN = "sk-ant-oat01-FAKE-CLI-TOKEN";
const EXPIRES_AT = Date.UTC(2026, 7, 19, 3, 14, 0);
const NOW = new Date(Date.UTC(2026, 7, 18, 12, 0, 0));

const CREDENTIALS = {
  claudeAiOauth: {
    accessToken: ACCESS_TOKEN,
    refreshToken: "sk-ant-ort01-FAKE-CLI-REFRESH",
    expiresAt: EXPIRES_AT,
    scopes: ["user:inference"],
    subscriptionType: "max",
  },
};

const SAMPLE_QUOTA: QuotaStatus = {
  fiveHour: { utilization: 42, resetsAt: "2026-08-18T20:00:01.000Z" },
  sevenDay: { utilization: 8, resetsAt: "2026-08-25T04:00:00.000Z" },
  sevenDaySonnet: { utilization: 6, resetsAt: "2026-08-19T18:00:00.000Z" },
  sevenDayOpus: null,
  extraUsage: null,
  fetchedAt: NOW.getTime(),
};

interface Harness {
  paths: AuthPaths;
  root: string;
  out: string[];
  err: string[];
  info: string[];
  deps: AuthCliDeps;
  envDeps: Partial<AuthEnvDeps>;
  [Symbol.dispose](): void;
}

function harness(opts?: { env?: Record<string, string | undefined>; platform?: string }): Harness {
  const root = mkdtempSync(join(tmpdir(), "mcx-authcli-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  const paths: AuthPaths = {
    profilesDir: join(root, ".mcp-cli", "auth-profiles"),
    credentialsPath: join(root, ".claude", ".credentials.json"),
    claudeConfigPath: join(root, ".claude.json"),
    policyLimitsPath: join(root, ".claude", "policy-limits.json"),
  };
  writeFileSync(paths.credentialsPath, JSON.stringify(CREDENTIALS), { mode: 0o600 });
  writeFileSync(
    paths.claudeConfigPath,
    JSON.stringify({ userID: "user-a", oauthAccount: { emailAddress: "a@example.com", accountUuid: "uuid-a" } }),
    { mode: 0o600 },
  );
  writeFileSync(paths.policyLimitsPath, JSON.stringify({ restrictions: { allow_remote_control: { allowed: true } } }), {
    mode: 0o600,
  });

  const out: string[] = [];
  const err: string[] = [];
  const info: string[] = [];
  const deps = {
    log: (...args: unknown[]) => out.push(args.map(String).join(" ")),
    printError: (msg: string) => err.push(msg),
    printInfo: (msg: string) => info.push(msg),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }),
  } as unknown as AuthCliDeps;

  return {
    paths,
    root,
    out,
    err,
    info,
    deps,
    envDeps: {
      paths,
      env: opts?.env ?? {},
      platform: opts?.platform ?? "linux",
      now: () => NOW,
      fetchQuota: async () => SAMPLE_QUOTA,
    },
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function expectExit(fn: () => Promise<void>, code: number): Promise<void> {
  try {
    await fn();
    throw new Error(`expected exit(${code})`);
  } catch (err) {
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(code);
  }
}

describe("mcx claude auth — dispatch", () => {
  test("unknown subcommand exits 1 with guidance on stderr", async () => {
    using h = harness();
    await expectExit(() => claudeAuth(["frobnicate"], h.deps, h.envDeps), 1);
    expect(h.err.join(" ")).toContain("Unknown claude auth subcommand");
    expect(h.out).toEqual([]);
  });

  test("missing subcommand exits 1", async () => {
    using h = harness();
    await expectExit(() => claudeAuth([], h.deps, h.envDeps), 1);
  });

  test("unknown flag exits 1", async () => {
    using h = harness();
    await expectExit(() => claudeAuth(["ls", "--bogus"], h.deps, h.envDeps), 1);
    expect(h.err.join(" ")).toContain("unknown flag");
  });

  test("save without a name exits 1", async () => {
    using h = harness();
    await expectExit(() => claudeAuth(["save"], h.deps, h.envDeps), 1);
    expect(h.err.join(" ")).toContain("Missing profile name");
  });

  test("darwin exits 2 with an unsupported-platform message and writes nothing", async () => {
    using h = harness({ platform: "darwin" });
    await expectExit(() => claudeAuth(["save", "work"], h.deps, h.envDeps), 2);
    expect(h.err.join(" ")).toContain("Linux-only");
    expect(existsSync(h.paths.profilesDir)).toBe(false);
  });

  test("loading an unknown profile exits 1", async () => {
    using h = harness();
    await expectExit(() => claudeAuth(["load", "nope"], h.deps, h.envDeps), 1);
    expect(h.err.join(" ")).toContain("No such auth profile");
  });

  test("an invalid profile name exits 1 without creating anything", async () => {
    using h = harness();
    await expectExit(() => claudeAuth(["save", "../escape"], h.deps, h.envDeps), 1);
    expect(h.err.join(" ")).toContain("Invalid profile name");
  });
});

describe("mcx claude auth save", () => {
  test("human output confirms the save and the new active profile", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);

    expect(h.out.join("\n")).toContain('Saved auth profile "work" (oauth)');
    expect(h.out.join("\n")).toContain('active profile is now "work"');
    expect(existsSync(join(h.paths.profilesDir, "work.json"))).toBe(true);
  });

  test("--json emits a machine-readable record with no token material", async () => {
    using h = harness();
    await claudeAuth(["save", "work", "--json"], h.deps, h.envDeps);

    const payload = JSON.parse(h.out.join("\n"));
    expect(payload).toMatchObject({ ok: true, action: "save", name: "work", kind: "oauth", active: true });
    expect(h.out.join("\n")).not.toContain(ACCESS_TOKEN);
  });

  test("--api-key-env records the variable name and warns on stderr", async () => {
    using h = harness();
    await claudeAuth(["save", "ci", "--api-key-env", "MY_KEY"], h.deps, h.envDeps);

    expect(h.out.join("\n")).toContain("expects env var: MY_KEY (value not stored)");
    expect(h.info.join(" ")).toContain("MY_KEY is not set");
    expect(readFileSync(join(h.paths.profilesDir, "ci.json"), "utf-8")).not.toContain(ACCESS_TOKEN);
  });

  test("--oauth captures the claude.ai identity despite an exported API key", async () => {
    using h = harness({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-SECRET" } });
    await claudeAuth(["save", "work", "--oauth", "--json"], h.deps, h.envDeps);

    const payload = JSON.parse(h.out.join("\n"));
    expect(payload.kind).toBe("oauth");
    expect(payload.apiKeyEnvVar).toBeNull();
    expect(readFileSync(join(h.paths.profilesDir, "work.json"), "utf-8")).not.toContain("sk-ant-api03-SECRET");
  });

  test("an exported ANTHROPIC_API_KEY makes save default to an api-key profile", async () => {
    using h = harness({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-SECRET" } });
    await claudeAuth(["save", "ci", "--json"], h.deps, h.envDeps);

    const payload = JSON.parse(h.out.join("\n"));
    expect(payload).toMatchObject({ kind: "api-key", apiKeyEnvVar: "ANTHROPIC_API_KEY", active: false });
  });

  test("save --json reports the resolved credential paths", async () => {
    using h = harness();
    await claudeAuth(["save", "work", "--json"], h.deps, h.envDeps);
    const payload = JSON.parse(h.out.join("\n"));
    expect(payload.credentialsPath).toBe(h.paths.credentialsPath);
    expect(payload.claudeConfigPath).toBe(h.paths.claudeConfigPath);
  });

  test("re-saving reports an update rather than a create", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    h.out.length = 0;
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    expect(h.out.join("\n")).toContain('Updated auth profile "work"');
  });

  test("quota fetch failure warns and still saves", async () => {
    using h = harness();
    h.envDeps.fetchQuota = async () => {
      throw new Error("network down");
    };
    await claudeAuth(["save", "work"], h.deps, h.envDeps);

    expect(h.info.join(" ")).toContain("could not snapshot quota: network down");
    expect(existsSync(join(h.paths.profilesDir, "work.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(h.paths.profilesDir, "work.json"), "utf-8")).quota).toBeUndefined();
  });

  test("api-key save does not call the usage API", async () => {
    using h = harness();
    let called = false;
    h.envDeps.fetchQuota = async () => {
      called = true;
      throw new Error("should not fetch");
    };
    await claudeAuth(["save", "ci", "--api-key-env", "MY_KEY"], h.deps, h.envDeps);
    expect(called).toBe(false);
  });
});

describe("mcx claude auth load", () => {
  test("switches identity and reports the side effects it performed", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    writeFileSync(h.paths.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "other" } }));
    writeFileSync(h.paths.claudeConfigPath, JSON.stringify({ userID: "user-b", keep: 1 }));
    await claudeAuth(["save", "personal"], h.deps, h.envDeps);
    h.out.length = 0;

    await claudeAuth(["load", "work"], h.deps, h.envDeps);

    const text = h.out.join("\n");
    expect(text).toContain('Loaded auth profile "work" (oauth)');
    expect(text).toContain("credentials written");
    expect(text).toContain("identity keys updated");
    expect(text).toContain("org policy cache invalidated");
    expect(JSON.parse(readFileSync(h.paths.claudeConfigPath, "utf-8")).userID).toBe("user-a");
    expect(existsSync(h.paths.policyLimitsPath)).toBe(false);
  });

  test("write-back snapshots quota onto the outgoing profile even when credentials are unchanged", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    writeFileSync(h.paths.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "other" } }));
    writeFileSync(
      h.paths.claudeConfigPath,
      JSON.stringify({ userID: "user-b", oauthAccount: { emailAddress: "b@x.com" } }),
    );
    await claudeAuth(["save", "personal"], h.deps, h.envDeps);

    h.envDeps.fetchQuota = async () => ({
      ...SAMPLE_QUOTA,
      fiveHour: { utilization: 91, resetsAt: "2026-08-18T21:00:00.000Z" },
    });
    await claudeAuth(["load", "work"], h.deps, h.envDeps);

    const personal = JSON.parse(readFileSync(join(h.paths.profilesDir, "personal.json"), "utf-8"));
    expect(personal.quota.fiveHour.utilization).toBe(91);
    expect(personal.quota.capturedAt).toBe(NOW.toISOString());
    expect(JSON.parse(readFileSync(join(h.paths.profilesDir, "work.json"), "utf-8")).quota.fiveHour.utilization).toBe(
      42,
    );
  });

  test("--json reports the write-back target and backup location", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    h.out.length = 0;

    await claudeAuth(["load", "work", "--json"], h.deps, h.envDeps);

    const payload = JSON.parse(h.out.join("\n"));
    expect(payload).toMatchObject({ ok: true, action: "load", name: "work", kind: "oauth", policyInvalidated: true });
    expect(payload.backupDir).toContain("backups");
    expect(h.out.join("\n")).not.toContain(ACCESS_TOKEN);
  });

  test("warnings go to stderr, not stdout", async () => {
    using h = harness();
    await claudeAuth(["save", "ci", "--api-key-env", "MY_KEY"], h.deps, h.envDeps);
    h.out.length = 0;
    h.info.length = 0;

    await claudeAuth(["load", "ci"], h.deps, h.envDeps);

    expect(h.info.join(" ")).toContain("export MY_KEY");
    expect(h.out.join("\n")).not.toContain("export MY_KEY");
  });
});

describe("mcx claude auth ls", () => {
  test("empty store prints a hint and valid JSON", async () => {
    using h = harness();
    await claudeAuth(["ls"], h.deps, h.envDeps);
    expect(h.out.join("\n")).toContain("No auth profiles saved");

    h.out.length = 0;
    await claudeAuth(["ls", "--json"], h.deps, h.envDeps);
    expect(JSON.parse(h.out.join("\n"))).toEqual([]);
  });

  test("lists saved profiles with account, expiry and remote-control, never a token", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    await claudeAuth(["save", "ci", "--api-key-env", "MY_KEY"], h.deps, h.envDeps);
    h.out.length = 0;

    await claudeAuth(["ls"], h.deps, h.envDeps);

    const text = h.out.join("\n");
    expect(text).toContain("NAME");
    expect(text).toContain("a@example.com");
    expect(text).toContain("$MY_KEY");
    expect(text).toContain("2026-08-19 03:14");
    expect(text).toContain("yes"); // remote control allowed per the policy fixture
    expect(text).toContain("* work"); // active marker
    expect(text).toContain("42%");
    expect(text).toContain("2026-08-18 20:00");
    expect(text).toContain("8%");
    expect(text).toContain("AS OF");
    expect(text).not.toContain(ACCESS_TOKEN);
  });

  test("--json exposes the summary fields agents need", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    h.out.length = 0;

    await claudeAuth(["ls", "--json"], h.deps, h.envDeps);

    const [entry] = JSON.parse(h.out.join("\n"));
    expect(entry).toMatchObject({
      name: "work",
      kind: "oauth",
      active: true,
      account: "a@example.com",
      allowRemoteControl: true,
      expired: false,
      quota: {
        capturedAt: NOW.toISOString(),
        fiveHour: { utilization: 42, resetsAt: "2026-08-18T20:00:01.000Z" },
        sevenDay: { utilization: 8, resetsAt: "2026-08-25T04:00:00.000Z" },
      },
    });
    expect(entry.expiresAt).toBe(new Date(EXPIRES_AT).toISOString());
  });

  test("ls works on darwin (it only reads the mcx-owned store)", async () => {
    using h = harness({ platform: "darwin" });
    await claudeAuth(["ls", "--json"], h.deps, h.envDeps);
    expect(JSON.parse(h.out.join("\n"))).toEqual([]);
  });
});

describe("formatProfileTable", () => {
  test("marks expired tokens and unknown policy without leaking secrets", () => {
    const lines = formatProfileTable([
      {
        name: "old",
        kind: "oauth",
        active: false,
        account: "old@example.com",
        organization: null,
        subscriptionType: "pro",
        expiresAt: "2020-01-01T00:00:00.000Z",
        expired: true,
        apiKeyEnvVar: null,
        allowRemoteControl: null,
        hasCredentials: true,
        updatedAt: NOW.toISOString(),
        quota: {
          capturedAt: "2020-01-01T00:00:00.000Z",
          fiveHour: { utilization: 97.5, resetsAt: "2020-01-01T05:00:00.000Z" },
          sevenDay: { utilization: 10, resetsAt: "2020-01-07T00:00:00.000Z" },
          sevenDaySonnet: null,
          sevenDayOpus: null,
          extraUsage: null,
        },
      },
    ]);

    const text = lines.join("\n");
    expect(text).toContain("2020-01-01 00:00 (expired)");
    expect(text).toContain("unknown");
    expect(text).toContain("97.5%");
    expect(text).toContain("2020-01-01 05:00");
    expect(text).toContain("AS OF");
    expect(text).not.toContain("Token");
  });

  test("falls back to a dash when the account is unknown", () => {
    const lines = formatProfileTable([
      {
        name: "bare",
        kind: "oauth",
        active: true,
        account: null,
        organization: null,
        subscriptionType: null,
        expiresAt: null,
        expired: null,
        apiKeyEnvVar: null,
        allowRemoteControl: true,
        hasCredentials: true,
        updatedAt: NOW.toISOString(),
        quota: null,
      },
    ]);
    expect(lines[1]).toContain("* bare");
    expect(lines[1]).toContain("-");
  });
});

describe("mcx claude auth — QA regressions", () => {
  test("ls still lists healthy profiles when one file is corrupt, warning on stderr", async () => {
    using h = harness();
    await claudeAuth(["save", "good"], h.deps, h.envDeps);
    writeFileSync(join(h.paths.profilesDir, "broken.json"), "{ not json", { mode: 0o600 });
    h.out.length = 0;
    h.info.length = 0;

    await claudeAuth(["ls", "--json"], h.deps, h.envDeps);

    expect(JSON.parse(h.out.join("\n")).map((p: { name: string }) => p.name)).toEqual(["good"]);
    expect(h.info.join(" ")).toContain('profile "broken" is unreadable');
  });

  test("an IO failure exits 1 with a clean message instead of a stack trace", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    const blocker = join(h.root, "blocker");
    writeFileSync(blocker, "not a directory");
    const brokenDeps = { ...h.envDeps, paths: { ...h.paths, credentialsPath: join(blocker, ".credentials.json") } };

    await expectExit(() => claudeAuth(["load", "work"], h.deps, brokenDeps), 1);

    expect(h.err.join(" ")).toContain("Could not");
    expect(h.err.join(" ")).not.toContain("at <anonymous>");
  });

  test("load --json reports how the outgoing credentials were preserved", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    h.out.length = 0;

    await claudeAuth(["load", "work", "--json"], h.deps, h.envDeps);

    const payload = JSON.parse(h.out.join("\n"));
    expect(payload.outgoingPreservedAs).toBe("write-back");
    expect(payload.wroteBack).toBe("work");
  });

  test("switching away from an api-key profile preserves the live credentials", async () => {
    using h = harness();
    await claudeAuth(["save", "work"], h.deps, h.envDeps);
    await claudeAuth(["save", "ci", "--api-key-env", "MY_KEY"], h.deps, h.envDeps);
    await claudeAuth(["load", "ci"], h.deps, h.envDeps);
    // Claude refreshes the token while the api-key profile is active.
    const refreshed = JSON.stringify({ claudeAiOauth: { accessToken: "cli-refreshed", expiresAt: EXPIRES_AT } });
    writeFileSync(h.paths.credentialsPath, refreshed);
    h.out.length = 0;

    await claudeAuth(["load", "work", "--json"], h.deps, h.envDeps);

    const payload = JSON.parse(h.out.join("\n"));
    expect(payload.outgoingPreservedAs).toBe("backup");
    expect(readFileSync(join(payload.orphanBackupDir, "credentials.json"), "utf-8")).toContain("cli-refreshed");
  });
});
