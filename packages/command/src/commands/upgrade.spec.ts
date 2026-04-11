import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchReleaseDeps, ReleaseInfo, UpdateCheckResult } from "@mcp-cli/core";
import { _restoreOptions, options } from "@mcp-cli/core";
import { cmdUpgrade, parseUpgradeArgs } from "./upgrade";

describe("parseUpgradeArgs", () => {
  test("empty args", () => {
    expect(parseUpgradeArgs([])).toEqual({ check: false, yes: false, json: false });
  });

  test("--check flag", () => {
    expect(parseUpgradeArgs(["--check"])).toEqual({ check: true, yes: false, json: false });
  });

  test("--yes flag", () => {
    expect(parseUpgradeArgs(["--yes"])).toEqual({ check: false, yes: true, json: false });
  });

  test("-y shorthand", () => {
    expect(parseUpgradeArgs(["-y"])).toEqual({ check: false, yes: true, json: false });
  });

  test("--json flag", () => {
    expect(parseUpgradeArgs(["--json"])).toEqual({ check: false, yes: false, json: true });
  });

  test("combined flags", () => {
    expect(parseUpgradeArgs(["--check", "--json"])).toEqual({ check: true, yes: false, json: true });
  });
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];

  const defaults = {
    version: "1.0.0",
    execPath: "/usr/local/bin/mcx",
    fetch: (() => Promise.resolve(new Response("", { status: 200 }))) as unknown as typeof fetch,
    checkForUpdate: (_v: string, _d?: Partial<FetchReleaseDeps & { skipCache: boolean }>): Promise<UpdateCheckResult> =>
      Promise.resolve({
        current: "1.0.0",
        latest: "1.0.0",
        updateAvailable: false,
        asset: "mcx-darwin-arm64.tar.gz",
      }),
    fetchLatestRelease: (_d?: Partial<FetchReleaseDeps>): Promise<ReleaseInfo> =>
      Promise.resolve({
        tag: "v2.0.0",
        version: "2.0.0",
        assets: [{ name: "mcx-darwin-arm64.tar.gz", url: "https://example.com/asset", size: 1024 }],
      }),
    selectAsset: () => "mcx-darwin-arm64.tar.gz",
    confirm: () => Promise.resolve(true),
    spawn: Bun.spawn,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
    ...overrides,
  };

  return { deps: defaults, logs, errors };
}

describe("cmdUpgrade --check", () => {
  test("prints up to date when no update available", async () => {
    const { deps, logs } = makeDeps();
    await cmdUpgrade(["--check"], deps);
    expect(logs.some((l) => l.includes("Up to date"))).toBe(true);
  });

  test("prints update available when newer version exists", async () => {
    const { deps, logs } = makeDeps({
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
        }),
    });
    await cmdUpgrade(["--check"], deps);
    expect(logs.some((l) => l.includes("Update available") && l.includes("2.0.0"))).toBe(true);
  });

  test("outputs JSON with --check --json", async () => {
    const { deps, logs } = makeDeps();
    await cmdUpgrade(["--check", "--json"], deps);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.current).toBe("1.0.0");
    expect(parsed.latest).toBe("1.0.0");
    expect(parsed.updateAvailable).toBe(false);
  });
});

describe("cmdUpgrade (install)", () => {
  test("prints already up to date when no update", async () => {
    const { deps, logs } = makeDeps();
    await cmdUpgrade(["--yes"], deps);
    expect(logs.some((l) => l.includes("Already up to date"))).toBe(true);
  });

  test("returns early when user declines confirmation", async () => {
    const { deps, errors } = makeDeps({
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
        }),
      confirm: () => Promise.resolve(false),
    });
    await cmdUpgrade([], deps);
    expect(errors.some((e) => e.includes("Cancelled"))).toBe(true);
  });

  test("reports unsupported platform", async () => {
    const { deps } = makeDeps({
      selectAsset: () => null,
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: null,
        }),
    });
    await cmdUpgrade(["--yes"], deps);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  test("outputs JSON when already up to date", async () => {
    const { deps, logs } = makeDeps();
    await cmdUpgrade(["--yes", "--json"], deps);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.status).toBe("up_to_date");
    expect(parsed.version).toBe("1.0.0");
  });

  test("fails when asset not found in release", async () => {
    const { deps } = makeDeps({
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
        }),
      fetchLatestRelease: () =>
        Promise.resolve({
          tag: "v2.0.0",
          version: "2.0.0",
          assets: [{ name: "mcx-linux-x64.tar.gz", url: "https://example.com/linux", size: 1024 }],
        }),
    });
    await cmdUpgrade(["--yes"], deps);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  test("fails when download returns non-OK", async () => {
    const { deps } = makeDeps({
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
        }),
      fetch: (() => Promise.resolve(new Response("error", { status: 500 }))) as unknown as typeof fetch,
    });
    await cmdUpgrade(["--yes"], deps);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

describe("cmdUpgrade full flow", () => {
  let tmpDir: string;
  let installDir: string;
  let origMcpCliDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcx-upgrade-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    installDir = join(tmpDir, "bin");
    mkdirSync(installDir, { recursive: true });
    origMcpCliDir = options.MCP_CLI_DIR;
    options.MCP_CLI_DIR = join(tmpDir, ".mcp-cli");
    mkdirSync(options.MCP_CLI_DIR, { recursive: true });
  });

  afterEach(() => {
    options.MCP_CLI_DIR = origMcpCliDir;
    rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function createTarball(): Promise<Uint8Array> {
    // Create a temp staging area with fake binaries
    const stageDir = join(tmpDir, "tar-source");
    mkdirSync(stageDir, { recursive: true });

    // Create a fake mcx that exits 0 when called with "version --json"
    const script = '#!/bin/sh\necho \'{"version":"2.0.0"}\'\n';
    writeFileSync(join(stageDir, "mcx"), script, { mode: 0o755 });
    writeFileSync(join(stageDir, "mcpd"), script, { mode: 0o755 });
    writeFileSync(join(stageDir, "mcpctl"), script, { mode: 0o755 });

    // Create tarball
    const proc = Bun.spawn(["tar", "czf", "-", "-C", stageDir, "mcx", "mcpd", "mcpctl"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const data = await new Response(proc.stdout).arrayBuffer();
    await proc.exited;
    return new Uint8Array(data);
  }

  test("downloads, extracts, verifies, and swaps binaries", async () => {
    const tarball = await createTarball();

    // Write existing "old" binaries
    writeFileSync(join(installDir, "mcx"), "old-mcx", { mode: 0o755 });

    const updateResult: UpdateCheckResult = {
      current: "1.0.0",
      latest: "2.0.0",
      updateAvailable: true,
      asset: "mcx-darwin-arm64.tar.gz",
    };

    const logs: string[] = [];
    const errors: string[] = [];

    await cmdUpgrade(["--yes"], {
      version: "1.0.0",
      execPath: join(installDir, "mcx"),
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () => Promise.resolve(updateResult),
      fetchLatestRelease: () =>
        Promise.resolve({
          tag: "v2.0.0",
          version: "2.0.0",
          assets: [{ name: "mcx-darwin-arm64.tar.gz", url: "https://example.com/asset", size: tarball.length }],
        }),
      selectAsset: () => "mcx-darwin-arm64.tar.gz",
      confirm: () => Promise.resolve(true),
      spawn: Bun.spawn,
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    });

    expect(logs.some((l) => l.includes("Updated 1.0.0"))).toBe(true);
    expect(logs.some((l) => l.includes("2.0.0"))).toBe(true);
    expect(existsSync(join(installDir, "mcx"))).toBe(true);
    expect(existsSync(join(installDir, "mcpd"))).toBe(true);
    // Stage dir should be cleaned up
    expect(existsSync(join(options.MCP_CLI_DIR, "staged"))).toBe(false);
  });

  test("outputs JSON on successful upgrade", async () => {
    const tarball = await createTarball();
    writeFileSync(join(installDir, "mcx"), "old-mcx", { mode: 0o755 });

    const logs: string[] = [];

    await cmdUpgrade(["--yes", "--json"], {
      version: "1.0.0",
      execPath: join(installDir, "mcx"),
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({ current: "1.0.0", latest: "2.0.0", updateAvailable: true, asset: "mcx-darwin-arm64.tar.gz" }),
      fetchLatestRelease: () =>
        Promise.resolve({
          tag: "v2.0.0",
          version: "2.0.0",
          assets: [{ name: "mcx-darwin-arm64.tar.gz", url: "https://example.com/asset", size: tarball.length }],
        }),
      selectAsset: () => "mcx-darwin-arm64.tar.gz",
      confirm: () => Promise.resolve(true),
      spawn: Bun.spawn,
      log: (msg: string) => logs.push(msg),
      error: () => {},
    });

    const parsed = JSON.parse(logs[0]);
    expect(parsed.status).toBe("updated");
    expect(parsed.from).toBe("1.0.0");
    expect(parsed.to).toBe("2.0.0");
  });

  test("fails when extraction produces no mcx binary", async () => {
    // Create an empty tarball (no mcx inside)
    const emptyDir = join(tmpDir, "empty-tar-source");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "readme.txt"), "no binaries here");
    const proc = Bun.spawn(["tar", "czf", "-", "-C", emptyDir, "readme.txt"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const tarball = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;

    await cmdUpgrade(["--yes"], {
      version: "1.0.0",
      execPath: join(installDir, "mcx"),
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({ current: "1.0.0", latest: "2.0.0", updateAvailable: true, asset: "mcx-darwin-arm64.tar.gz" }),
      fetchLatestRelease: () =>
        Promise.resolve({
          tag: "v2.0.0",
          version: "2.0.0",
          assets: [{ name: "mcx-darwin-arm64.tar.gz", url: "https://example.com/asset", size: tarball.length }],
        }),
      selectAsset: () => "mcx-darwin-arm64.tar.gz",
      confirm: () => Promise.resolve(true),
      spawn: Bun.spawn,
      log: () => {},
      error: () => {},
    });

    expect(process.exitCode).toBe(1);
  });

  test("fails when staged binary verification fails", async () => {
    // Create a tarball with a mcx that exits non-zero
    const stageDir = join(tmpDir, "bad-bin-source");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "mcx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const proc = Bun.spawn(["tar", "czf", "-", "-C", stageDir, "mcx"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const tarball = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;

    await cmdUpgrade(["--yes"], {
      version: "1.0.0",
      execPath: join(installDir, "mcx"),
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({ current: "1.0.0", latest: "2.0.0", updateAvailable: true, asset: "mcx-darwin-arm64.tar.gz" }),
      fetchLatestRelease: () =>
        Promise.resolve({
          tag: "v2.0.0",
          version: "2.0.0",
          assets: [{ name: "mcx-darwin-arm64.tar.gz", url: "https://example.com/asset", size: tarball.length }],
        }),
      selectAsset: () => "mcx-darwin-arm64.tar.gz",
      confirm: () => Promise.resolve(true),
      spawn: Bun.spawn,
      log: () => {},
      error: () => {},
    });

    expect(process.exitCode).toBe(1);
  });
});
