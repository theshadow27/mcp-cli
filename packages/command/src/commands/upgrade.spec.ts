import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckForUpdateDeps, FetchReleaseDeps, ReleaseInfo, UpdateCheckResult } from "@mcp-cli/core";
import { _restoreOptions, options, readInstallMarker } from "@mcp-cli/core";
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
    fetch: (() => Promise.resolve(new Response("", { status: 200 }))) as unknown as typeof fetch,
    checkForUpdate: (_v: string, _d?: CheckForUpdateDeps): Promise<UpdateCheckResult> =>
      Promise.resolve({
        current: "1.0.0",
        latest: "1.0.0",
        updateAvailable: false,
        asset: "mcx-darwin-arm64.tar.gz",
        // A release install proven by an install marker — the only state that
        // may be reported as a flat "up to date" (#3260).
        provenance: "release",
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
          provenance: "unknown",
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

  test("reports a local build honestly instead of claiming up to date (#3232)", async () => {
    const { deps, logs } = makeDeps({
      version: "1.14.6+1787442054",
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.14.6+1787442054",
          latest: "1.14.6",
          updateAvailable: false,
          asset: "mcx-linux-x64.tar.gz",
          provenance: "dev",
        }),
    });
    await cmdUpgrade(["--check"], deps);
    expect(logs.some((l) => l.includes("local build"))).toBe(true);
    expect(logs.some((l) => l.includes("Up to date"))).toBe(false);
  });

  test("an unverifiable build is reported as unconfirmed, not as a dev build (#3260)", async () => {
    // The #3260 regression: a genuine release install carries +epoch like
    // every compiled binary, so an unprovable state must not be asserted as
    // "dev build" — nor silently as "Up to date".
    const { deps, logs } = makeDeps({
      version: "2.0.0+1787442054",
      checkForUpdate: () =>
        Promise.resolve({
          current: "2.0.0+1787442054",
          latest: "2.0.0",
          updateAvailable: false,
          asset: "mcx-linux-x64.tar.gz",
          provenance: "unknown",
        }),
    });
    await cmdUpgrade(["--check"], deps);
    expect(logs.some((l) => l.includes("cannot confirm"))).toBe(true);
    // It may name "a local build" as one of the possibilities, but must never
    // assert the binary *is* one — that assertion is the #3260 defect.
    expect(logs.some((l) => l.includes("You are running a local build"))).toBe(false);
    expect(logs.some((l) => l.includes("Up to date"))).toBe(false);
  });

  test("reports a marker-proven release install as up to date (#3260)", async () => {
    const { deps, logs } = makeDeps({
      version: "2.0.0+1787442054",
      checkForUpdate: () =>
        Promise.resolve({
          current: "2.0.0+1787442054",
          latest: "2.0.0",
          updateAvailable: false,
          asset: "mcx-linux-x64.tar.gz",
          provenance: "release",
        }),
    });
    await cmdUpgrade(["--check"], deps);
    expect(logs.some((l) => l.includes("Up to date"))).toBe(true);
    expect(logs.some((l) => l.includes("dev build"))).toBe(false);
  });
});

describe("cmdUpgrade (install)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("prints already up to date when no update", async () => {
    const { deps, logs } = makeDeps();
    await cmdUpgrade(["--yes"], deps);
    expect(logs.some((l) => l.includes("Already up to date"))).toBe(true);
  });

  test("reports a local build honestly instead of 'Already up to date' (#3232)", async () => {
    const { deps, logs } = makeDeps({
      version: "1.14.6+1787442054",
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.14.6+1787442054",
          latest: "1.14.6",
          updateAvailable: false,
          asset: "mcx-linux-x64.tar.gz",
          provenance: "dev",
        }),
    });
    await cmdUpgrade(["--yes"], deps);
    expect(logs.some((l) => l.includes("local build"))).toBe(true);
    expect(logs.some((l) => l.includes("Already up to date"))).toBe(false);
  });

  test("outputs JSON status dev_build for a local build (#3232)", async () => {
    const { deps, logs } = makeDeps({
      version: "1.14.6+1787442054",
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.14.6+1787442054",
          latest: "1.14.6",
          updateAvailable: false,
          asset: "mcx-linux-x64.tar.gz",
          provenance: "dev",
        }),
    });
    await cmdUpgrade(["--yes", "--json"], deps);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.status).toBe("dev_build");
    expect(parsed.version).toBe("1.14.6+1787442054");
  });

  test("outputs JSON status unverified_build when provenance is unknown (#3260)", async () => {
    const { deps, logs } = makeDeps({
      version: "2.0.0+1787442054",
      checkForUpdate: () =>
        Promise.resolve({
          current: "2.0.0+1787442054",
          latest: "2.0.0",
          updateAvailable: false,
          asset: "mcx-linux-x64.tar.gz",
          provenance: "unknown",
        }),
    });
    await cmdUpgrade(["--yes", "--json"], deps);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.status).toBe("unverified_build");
  });

  test("returns early when user declines confirmation", async () => {
    const { deps, errors } = makeDeps({
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown",
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
          provenance: "unknown",
        }),
    });
    await cmdUpgrade(["--yes"], deps);
    expect(process.exitCode).toBe(1);
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
          provenance: "unknown",
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
  });

  test("fails when download returns non-OK", async () => {
    const { deps } = makeDeps({
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown",
        }),
      fetch: (() => Promise.resolve(new Response("error", { status: 500 }))) as unknown as typeof fetch,
    });
    await cmdUpgrade(["--yes"], deps);
    expect(process.exitCode).toBe(1);
  });

  test("catches thrown errors and sets exit code", async () => {
    const { deps, errors } = makeDeps({
      checkForUpdate: () => Promise.reject(new Error("DNS resolution failed")),
    });
    await cmdUpgrade(["--yes"], deps);
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("DNS resolution failed"))).toBe(true);
  });

  test("catches thrown errors in --check mode", async () => {
    const { deps, errors } = makeDeps({
      checkForUpdate: () => Promise.reject(new Error("network timeout")),
    });
    await cmdUpgrade(["--check"], deps);
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("network timeout"))).toBe(true);
  });
});

describe("cmdUpgrade full flow", () => {
  let tmpDir: string;
  let origMcpCliDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcx-upgrade-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    origMcpCliDir = options.MCP_CLI_DIR;
    options.MCP_CLI_DIR = join(tmpDir, ".mcp-cli");
    mkdirSync(options.MCP_CLI_DIR, { recursive: true });
  });

  afterEach(() => {
    options.MCP_CLI_DIR = origMcpCliDir;
    rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  function binDir(): string {
    return join(options.MCP_CLI_DIR, "bin");
  }

  function versionDir(version: string): string {
    return join(binDir(), "versions", version);
  }

  async function createTarball(versionOutput = "2.0.0"): Promise<Uint8Array> {
    // Create a temp staging area with fake binaries
    const stageDir = join(tmpDir, "tar-source");
    mkdirSync(stageDir, { recursive: true });

    // Fake mcx/mcpd/mcpctl: `--version` (used for staged-binary verification,
    // see upgrade.ts — it must never touch the daemon/IPC layer) prints the
    // plain-text format main.ts's real --version flag prints.
    const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'mcp-cli ${versionOutput}'; else echo ok; fi\n`;
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

  test("downloads, extracts, verifies, and installs into a versioned dir with real file copies", async () => {
    const tarball = await createTarball();

    // Simulate a pre-existing install (a prior version's copy) to prove the
    // old versioned binary is untouched and only the bin-dir copy changes.
    const oldVersionDir = versionDir("1.0.0");
    mkdirSync(oldVersionDir, { recursive: true });
    writeFileSync(join(oldVersionDir, "mcx"), "old-mcx", { mode: 0o755 });
    mkdirSync(binDir(), { recursive: true });
    copyFileSync(join(oldVersionDir, "mcx"), join(binDir(), "mcx"));

    const updateResult: UpdateCheckResult = {
      current: "1.0.0",
      latest: "2.0.0",
      updateAvailable: true,
      asset: "mcx-darwin-arm64.tar.gz",
      provenance: "unknown",
    };

    const logs: string[] = [];
    const errors: string[] = [];

    await cmdUpgrade(["--yes"], {
      version: "1.0.0",
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

    // Versioned install location — the owned, never-a-git-checkout location.
    expect(existsSync(join(versionDir("2.0.0"), "mcx"))).toBe(true);
    expect(existsSync(join(versionDir("2.0.0"), "mcpd"))).toBe(true);
    expect(existsSync(join(versionDir("2.0.0"), "mcpctl"))).toBe(true);

    // The prior version's files are untouched (installs are additive, not overwritten in place).
    expect(existsSync(join(oldVersionDir, "mcx"))).toBe(true);
    expect(readFileSync(join(oldVersionDir, "mcx"), "utf-8")).toBe("old-mcx");

    // The $PATH-facing file is a real copy, never a symlink (#3231: a
    // symlink install is the root cause this rewrite exists to eliminate),
    // and its content now matches the newly installed version, not the old one.
    const target = join(binDir(), "mcx");
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(readFileSync(join(versionDir("2.0.0"), "mcx"), "utf-8"));
    expect(readFileSync(target, "utf-8")).not.toBe("old-mcx");

    // The executable bit survives the copy.
    expect(statSync(target).mode & 0o111).not.toBe(0);

    // No leftover backup files after a successful install.
    expect(existsSync(`${target}.bak-${process.pid}`)).toBe(false);

    // Stage dir should be cleaned up
    expect(existsSync(join(options.MCP_CLI_DIR, "staged"))).toBe(false);

    // Install provenance is recorded (#3260) — this is what lets the *next*
    // `mcx upgrade --check` say "up to date" instead of guessing from the
    // `+epoch` suffix that every compiled binary carries. Both the versioned
    // copy and the $PATH-facing copy are covered, since either may be run.
    const marker = readInstallMarker();
    expect(marker?.version).toBe("2.0.0");
    expect(marker?.source).toBe("mcx-upgrade");
    const markedPaths = marker?.binaries.map((b) => b.path) ?? [];
    expect(markedPaths).toContain(target);
    expect(markedPaths).toContain(join(versionDir("2.0.0"), "mcx"));
    // The marker describes the installed *bytes*, so any later overwrite stops
    // matching — including one that happens to be the same length (#3260).
    const markedTarget = marker?.binaries.find((b) => b.path === target);
    expect(markedTarget?.size).toBe(statSync(target).size);
    expect(markedTarget?.sha256).toBe(createHash("sha256").update(readFileSync(target)).digest("hex"));
  });

  /** Run the happy-path 1.0.0 → 2.0.0 install against a prepared tarball. */
  async function runUpgrade(tarball: Uint8Array): Promise<void> {
    await cmdUpgrade(["--yes"], {
      version: "1.0.0",
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown" as const,
        }),
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
  }

  test("replaces a pre-existing symlink at the $PATH target instead of writing through it (#3231)", async () => {
    const tarball = await createTarball();

    // The #3231 failure mode: `<bin>/mcx` is an old symlink into some other
    // tree (a git worktree's dist/). Installing must replace the *link* with a
    // real file — never follow it and rewrite whatever it points at, which is
    // how a routine `bun build` came to hot-swap the live daemon's binary.
    const decoy = join(tmpDir, "decoy-dist", "mcx");
    mkdirSync(join(tmpDir, "decoy-dist"), { recursive: true });
    writeFileSync(decoy, "decoy-bytes", { mode: 0o755 });
    mkdirSync(binDir(), { recursive: true });
    const target = join(binDir(), "mcx");
    symlinkSync(decoy, target);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    await runUpgrade(tarball);

    // The link is gone: the target is now a regular file holding the new bytes.
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(readFileSync(join(versionDir("2.0.0"), "mcx"), "utf-8"));
    expect(readFileSync(target, "utf-8")).not.toBe("decoy-bytes");

    // The file the old link pointed at is untouched — nothing was written
    // through the symlink.
    expect(existsSync(decoy)).toBe(true);
    expect(lstatSync(decoy).isFile()).toBe(true);
    expect(readFileSync(decoy, "utf-8")).toBe("decoy-bytes");

    // The exec bit survives, and no sibling temp/backup file is left behind.
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(existsSync(`${target}.new-${process.pid}`)).toBe(false);
    expect(existsSync(`${target}.bak-${process.pid}`)).toBe(false);
  });

  test("replaces a dangling symlink at the $PATH target (#3231: the linked tree is already gone)", async () => {
    const tarball = await createTarball();

    // Same shape, but the worktree the link pointed into has since been
    // deleted. `existsSync(target)` is false through a dangling link, so the
    // install takes the no-backup branch — the rename must still land.
    mkdirSync(binDir(), { recursive: true });
    const target = join(binDir(), "mcx");
    symlinkSync(join(tmpDir, "deleted-worktree", "dist", "mcx"), target);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);

    await runUpgrade(tarball);

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(readFileSync(join(versionDir("2.0.0"), "mcx"), "utf-8"));
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(existsSync(`${target}.new-${process.pid}`)).toBe(false);
  });

  test("outputs JSON on successful upgrade, including install locations", async () => {
    const tarball = await createTarball();
    const logs: string[] = [];

    await cmdUpgrade(["--yes", "--json"], {
      version: "1.0.0",
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown",
        }),
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
    expect(parsed.installDir).toBe(versionDir("2.0.0"));
    expect(parsed.binDir).toBe(binDir());
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
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown",
        }),
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

  test("fails when staged binary verification fails (non-zero exit)", async () => {
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
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown",
        }),
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

  test("fails when staged binary reports the wrong version (mismatch, not up-to-date passthrough)", async () => {
    // Staged binary reports 1.9.9 while the release we downloaded is 2.0.0 —
    // must fail loudly rather than install a binary that doesn't match.
    const tarball = await createTarball("1.9.9");

    await cmdUpgrade(["--yes"], {
      version: "1.0.0",
      fetch: ((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(tarball as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch,
      checkForUpdate: () =>
        Promise.resolve({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          asset: "mcx-darwin-arm64.tar.gz",
          provenance: "unknown",
        }),
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
    expect(existsSync(versionDir("2.0.0"))).toBe(false);
  });
});
