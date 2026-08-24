/**
 * `mcx upgrade` — download and install versioned mcx release binaries.
 *
 * Install layout (owned by mcx, never a git checkout — see #3231/#3232):
 *   ~/.mcp-cli/bin/versions/<version>/{mcx,mcpd,mcpctl}   versioned, immutable once installed
 *   ~/.mcp-cli/bin/{mcx,mcpd,mcpctl}                       stable symlinks → the active version
 *                                                           (this is the directory install.sh
 *                                                           already tells users to put on $PATH)
 *
 * A running daemon is NOT restarted automatically — an upgrade only swaps
 * the on-disk symlinks, and a live daemon keeps running against its
 * already-loaded binary until explicitly restarted. This is a deliberate
 * "restart required" policy for this iteration (#3232): automatically
 * killing a daemon mid-upgrade could drop in-flight tracked work items and
 * live `mcx monitor` streams, which is exactly the interruption #3231
 * exists to prevent. The operator (or a future automation) restarts via
 * `mcx daemon restart` on their own schedule.
 *
 * Flags:
 *   --check       Check for update without installing
 *   --yes / -y    Skip confirmation prompt
 *   --json / -j   JSON output
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { BUILD_VERSION, options } from "@mcp-cli/core";
import {
  type FetchReleaseDeps,
  type ReleaseInfo,
  type UpdateCheckResult,
  checkForUpdate,
  fetchLatestRelease,
  selectAsset,
  writeCheckCache,
} from "@mcp-cli/core";

export interface UpgradeDeps {
  /** Current binary's version — must carry build metadata (BUILD_VERSION), not the bare package version. */
  version: string;
  fetch: typeof globalThis.fetch;
  checkForUpdate: (
    version: string,
    deps?: Partial<FetchReleaseDeps & { skipCache: boolean }>,
  ) => Promise<UpdateCheckResult>;
  fetchLatestRelease: (deps?: Partial<FetchReleaseDeps>) => Promise<ReleaseInfo>;
  selectAsset: (platform?: string, arch?: string) => string | null;
  confirm: (message: string) => Promise<boolean>;
  spawn: typeof Bun.spawn;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultDeps: UpgradeDeps = {
  version: BUILD_VERSION,
  fetch: globalThis.fetch,
  checkForUpdate,
  fetchLatestRelease,
  selectAsset,
  confirm: confirmTty,
  spawn: Bun.spawn,
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
};

interface ParsedArgs {
  check: boolean;
  yes: boolean;
  json: boolean;
}

export function parseUpgradeArgs(args: string[]): ParsedArgs {
  let check = false;
  let yes = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--check") check = true;
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--json" || arg === "-j") json = true;
  }
  return { check, yes, json };
}

export async function cmdUpgrade(args: string[], deps?: Partial<UpgradeDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const parsed = parseUpgradeArgs(args);

  try {
    if (parsed.check) {
      await runCheck(d, parsed.json);
      return;
    }

    await runUpgrade(d, parsed);
  } catch (err) {
    d.error(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function runCheck(d: UpgradeDeps, json: boolean): Promise<void> {
  const result = await d.checkForUpdate(d.version, { fetch: d.fetch, skipCache: true });

  if (json) {
    d.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.updateAvailable) {
    d.log(`Update available: ${result.current} → ${result.latest}`);
    d.log(`Run 'mcx upgrade' to install.`);
  } else if (result.devBuild) {
    d.log(devBuildMessage(result));
  } else {
    d.log(`Up to date (${result.current})`);
  }
}

/** Honest status line for a dev/local build at (or ahead of) the latest release's version number. */
function devBuildMessage(result: UpdateCheckResult): string {
  return `You are running a dev build (${result.current}) — newer than the latest release (${result.latest}). No release upgrade is available; this is expected for a locally built binary and is not the same as an installed release.`;
}

async function runUpgrade(d: UpgradeDeps, parsed: ParsedArgs): Promise<void> {
  const assetName = d.selectAsset();
  if (!assetName) {
    d.error(`Unsupported platform: ${process.platform}-${process.arch}`);
    process.exitCode = 1;
    return;
  }

  d.error("Checking for updates...");
  const result = await d.checkForUpdate(d.version, { fetch: d.fetch, skipCache: true });

  if (!result.updateAvailable) {
    if (parsed.json) {
      d.log(
        JSON.stringify(
          { status: result.devBuild ? "dev_build" : "up_to_date", version: result.current, latest: result.latest },
          null,
          2,
        ),
      );
    } else if (result.devBuild) {
      d.log(devBuildMessage(result));
    } else {
      d.log(`Already up to date (${result.current})`);
    }
    return;
  }

  d.error(`Update available: ${result.current} → ${result.latest}`);

  if (!parsed.yes) {
    const ok = await d.confirm(`Install ${result.latest}?`);
    if (!ok) {
      d.error("Cancelled.");
      return;
    }
  }

  // Fetch full release for download URLs
  const release = await d.fetchLatestRelease({ fetch: d.fetch });
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    d.error(`Asset ${assetName} not found in release ${release.tag}`);
    process.exitCode = 1;
    return;
  }

  // Download to staging directory
  const stageDir = join(options.MCP_CLI_DIR, "staged");
  mkdirSync(stageDir, { recursive: true });
  const tarPath = join(stageDir, assetName);

  d.error(`Downloading ${assetName} (${formatBytes(asset.size)})...`);
  const resp = await d.fetch(asset.url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "mcx-upgrade" },
    redirect: "follow",
  });
  if (!resp.ok) {
    d.error(`Download failed: HTTP ${resp.status}`);
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  await Bun.write(tarPath, resp);

  // Extract tarball
  d.error("Extracting...");
  const tar = d.spawn(["tar", "xzf", tarPath, "-C", stageDir], { stdout: "ignore", stderr: "pipe" });
  const tarExit = await tar.exited;
  if (tarExit !== 0) {
    const stderr = await new Response(tar.stderr).text();
    d.error(`Extraction failed (exit ${tarExit}): ${stderr.trim()}`);
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Verify staged binaries
  const stagedMcx = join(stageDir, "mcx");
  const stagedMcpd = join(stageDir, "mcpd");
  const stagedMcpctl = join(stageDir, "mcpctl");

  if (!existsSync(stagedMcx)) {
    d.error("Staged mcx binary not found after extraction");
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Verify with the process-level `--version` flag: it's handled before any
  // command dispatch (packages/command/src/main.ts) and never touches the
  // daemon/IPC layer. Deliberately NOT `mcx version --json` — that call
  // path auto-starts a daemon (see daemon-lifecycle.ts's ipcCall →
  // ensureDaemon), which would risk a *second* daemon racing the real
  // production one on the same socket mid-upgrade — exactly the
  // interruption #3231 exists to prevent.
  d.error("Verifying staged binary...");
  const verify = d.spawn([stagedMcx, "--version"], { stdout: "pipe", stderr: "ignore" });
  const verifyOut = await new Response(verify.stdout).text();
  const verifyExit = await verify.exited;
  if (verifyExit !== 0) {
    d.error(`Verification failed: staged mcx exited with ${verifyExit}`);
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Confirm the staged binary reports the expected version ("mcp-cli <version>")
  const verifyMatch = verifyOut.trim().match(/^mcp-cli (.+)$/);
  if (!verifyMatch || verifyMatch[1] !== release.version) {
    d.error(`Version mismatch: staged binary reports "${verifyOut.trim()}", expected mcp-cli ${release.version}`);
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Install: an owned, versioned location under MCP_CLI_DIR — never derived
  // from where the currently-running binary happens to live (that could be
  // a git worktree's dist/, see #3231). `<bin>/versions/<version>/` is
  // immutable once installed; `<bin>/{mcx,mcpd,mcpctl}` are stable symlinks
  // into it, matching the directory scripts/install.sh already tells users
  // to put on $PATH.
  const binDir = join(options.MCP_CLI_DIR, "bin");
  const versionDir = join(binDir, "versions", release.version);
  d.error(`Installing ${release.version} → ${versionDir}...`);

  const binaries: Array<[string, string]> = [
    [stagedMcx, join(versionDir, "mcx")],
    [stagedMcpd, join(versionDir, "mcpd")],
    [stagedMcpctl, join(versionDir, "mcpctl")],
  ];

  // Filter to only binaries that exist in the staging dir
  const toInstall = binaries.filter(([staged]) => existsSync(staged));

  // Phase 1: lay down the versioned install directory. Nothing on $PATH is
  // touched yet, so a failure here leaves the previous install fully intact.
  try {
    mkdirSync(versionDir, { recursive: true });
    for (const [staged, target] of toInstall) {
      moveFile(staged, target);
    }
  } catch (err) {
    d.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    rmSync(versionDir, { recursive: true, force: true });
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Phase 2: atomically repoint the stable symlinks at the new version.
  // Best-effort rollback to the previous target if any relink fails partway.
  mkdirSync(binDir, { recursive: true });
  const relinked: Array<{ link: string; previousTarget: string | null }> = [];
  try {
    for (const [, target] of toInstall) {
      const name = basename(target);
      const linkPath = join(binDir, name);
      const previousTarget = readSymlink(linkPath);
      relinkAtomic(linkPath, target);
      relinked.push({ link: linkPath, previousTarget });
    }
  } catch (err) {
    d.error(`Symlink swap failed: ${err instanceof Error ? err.message : String(err)}`);
    for (const { link, previousTarget } of relinked) {
      try {
        if (previousTarget) relinkAtomic(link, previousTarget);
      } catch {
        /* best effort rollback */
      }
    }
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  cleanup(stageDir);

  // Invalidate update-check cache so --check reflects new version
  writeCheckCache(result.latest);

  if (parsed.json) {
    d.log(
      JSON.stringify(
        { status: "updated", from: result.current, to: result.latest, installDir: versionDir, binDir },
        null,
        2,
      ),
    );
  } else {
    d.log(`Updated ${result.current} → ${result.latest}`);
    d.log(`Installed to ${versionDir}`);
    d.log(`${binDir}/{mcx,mcpd,mcpctl} now point at ${release.version}`);
    d.log(
      "Restart required: a running daemon keeps using its already-loaded binary until you run 'mcx daemon restart'.",
    );
  }
}

function cleanup(stageDir: string): void {
  try {
    rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Rename a file, falling back to copy+delete on EXDEV (cross-filesystem). */
function moveFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(src, dst);
      unlinkSync(src);
    } else {
      throw err;
    }
  }
}

/** Read a symlink's target, or null if `linkPath` doesn't exist / isn't a symlink. */
function readSymlink(linkPath: string): string | null {
  try {
    return readlinkSync(linkPath);
  } catch {
    return null;
  }
}

/**
 * Point `linkPath` at `target`, atomically on POSIX (create a sibling
 * symlink, then rename over the old one — never a window with no link or a
 * half-written one).
 */
function relinkAtomic(linkPath: string, target: string): void {
  const tmpLink = `${linkPath}.new-${process.pid}`;
  try {
    unlinkSync(tmpLink);
  } catch {
    /* didn't exist */
  }
  symlinkSync(target, tmpLink);
  renameSync(tmpLink, linkPath);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function confirmTty(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`${message} [y/N] `);

  for await (const chunk of process.stdin) {
    const line = Buffer.from(chunk).toString("utf-8").trim().toLowerCase();
    return line === "y" || line === "yes";
  }
  return false;
}
