import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    envDeps: { paths, env: opts?.env ?? {}, platform: opts?.platform ?? "linux", now: () => NOW },
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
      },
    ]);

    const text = lines.join("\n");
    expect(text).toContain("2020-01-01 00:00 (expired)");
    expect(text).toContain("unknown");
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
      },
    ]);
    expect(lines[1]).toContain("* bare");
    expect(lines[1]).toContain("-");
  });
});
