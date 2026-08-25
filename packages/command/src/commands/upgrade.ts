/**
 * `mcx upgrade` — download and install versioned mcx release binaries.
 *
 * Install layout (owned by mcx, never a git checkout — see #3231/#3232):
 *   ~/.mcp-cli/bin/versions/<version>/{mcx,mcpd,mcpctl}   versioned, immutable once installed
 *   ~/.mcp-cli/bin/{mcx,mcpd,mcpctl}                       the active version, by real file copy
 *                                                           (this is the directory install.sh
 *                                                           already tells users to put on $PATH)
 *
 * The $PATH-facing files are installed by COPY, never a symlink. #3231's
 * evidence was a symlink from `~/.local/bin/{mcx,mcpd,mcpctl}` into this
 * repo's `dist/` — a plain `bun build` in the dev tree silently rewrote the
 * file backing the production daemon's `$PATH` entry out from under it.
 * `versions/<version>/` here is an mcx-owned directory, not a git checkout,
 * so that specific failure mode doesn't apply to it — but a blanket "copy,
 * never symlink" policy for the install step is simpler to reason about and
 * audit than "symlink, except when the target is safe," so that's the rule.
 * Each copy is staged as a sibling temp file and `rename()`d over the old
 * one — atomic on POSIX, so a running daemon that already has the old file
 * open keeps executing the detached old inode until it restarts; readers
 * never see a partially-written binary.
 *
 * A running daemon is NOT restarted automatically — an upgrade only swaps
 * the on-disk files, and a live daemon keeps running against its
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

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { BUILD_VERSION, options } from "@mcp-cli/core";
import {
  type BuildProvenance,
  type CheckForUpdateDeps,
  type FetchReleaseDeps,
  type ReleaseInfo,
  type UpdateCheckResult,
  checkForUpdate,
  fetchLatestRelease,
  selectAsset,
  writeCheckCache,
  writeInstallMarker,
} from "@mcp-cli/core";

export interface UpgradeDeps {
  /** Current binary's version — must carry build metadata (BUILD_VERSION), not the bare package version. */
  version: string;
  fetch: typeof globalThis.fetch;
  checkForUpdate: (version: string, deps?: CheckForUpdateDeps) => Promise<UpdateCheckResult>;
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
  } else {
    d.log(noUpdateMessage(result));
  }
}

/** `--json` status for each "no newer release" provenance state. */
const NO_UPDATE_STATUS: Record<BuildProvenance, string> = {
  release: "up_to_date",
  dev: "dev_build",
  unknown: "unverified_build",
};

/**
 * Status line for "no newer release to install", worded by what we can
 * actually prove about this binary (#3260).
 *
 * The `dev` and `unknown` states are deliberately distinct. Saying "you are
 * running a dev build" when we merely can't prove otherwise is the exact
 * false claim #3260 filed — every release binary carries `+epoch`, so the old
 * `+`-detection told genuine release installs they were dev builds.
 */
function noUpdateMessage(result: UpdateCheckResult, alreadyUpToDate = false): string {
  switch (result.provenance) {
    case "release":
      return alreadyUpToDate ? `Already up to date (${result.current})` : `Up to date (${result.current})`;
    case "dev":
      return `You are running a local build (${result.current}), not an installed release. The latest release is ${result.latest}; no release upgrade is available.`;
    case "unknown":
      return `No newer release available (running ${result.current}, latest release is ${result.latest}). This binary carries no install record, so mcx cannot confirm whether it is the official ${result.latest} release or a local build of the same version. Re-running the release installer records one.`;
  }
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
          { status: NO_UPDATE_STATUS[result.provenance], version: result.current, latest: result.latest },
          null,
          2,
        ),
      );
    } else {
      // `mcx upgrade` was asked to install, so a proven-current install reads
      // as "Already up to date"; `--check` just reports the state.
      d.log(noUpdateMessage(result, true));
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
  // immutable once installed; `<bin>/{mcx,mcpd,mcpctl}` are real file
  // copies of it (never symlinks — see the file header), matching the
  // directory scripts/install.sh already tells users to put on $PATH.
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

  // Phase 2: atomically COPY each versioned binary into the $PATH-facing
  // bin dir (never a symlink — see file header). Each target file is
  // backed up before being overwritten; best-effort rollback to that
  // backup if a later copy in this batch fails partway.
  mkdirSync(binDir, { recursive: true });
  const installed: Array<{ target: string; backupPath: string | null }> = [];
  try {
    for (const [, versionedPath] of toInstall) {
      const name = basename(versionedPath);
      const target = join(binDir, name);
      const backupPath = existsSync(target) ? `${target}.bak-${process.pid}` : null;
      if (backupPath) copyFileSync(target, backupPath);
      copyAtomic(versionedPath, target);
      installed.push({ target, backupPath });
    }
  } catch (err) {
    d.error(`Install to ${binDir} failed: ${err instanceof Error ? err.message : String(err)}`);
    for (const { target, backupPath } of installed) {
      try {
        if (backupPath) copyAtomic(backupPath, target);
      } catch {
        /* best effort rollback */
      }
    }
    for (const { backupPath } of installed) {
      try {
        if (backupPath) unlinkSync(backupPath);
      } catch {
        /* best effort */
      }
    }
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Success: drop the backups.
  for (const { backupPath } of installed) {
    try {
      if (backupPath) unlinkSync(backupPath);
    } catch {
      /* best effort */
    }
  }

  cleanup(stageDir);

  // Record install provenance (#3260). The installer is the only party that
  // knows these bytes came from an official release — BUILD_VERSION's `+epoch`
  // is stamped on every compiled binary, dev builds included, so a binary
  // cannot work this out about itself. Both the versioned copies and the
  // $PATH-facing ones are recorded, since either may be the one that runs.
  // Advisory: a failure here costs a "release" verdict on the next --check,
  // never the install itself, so it must not fail an otherwise-good upgrade.
  try {
    writeInstallMarker(release.version, "mcx-upgrade", [
      ...toInstall.map(([, versionedPath]) => versionedPath),
      ...installed.map(({ target }) => target),
    ]);
  } catch (err) {
    d.error(
      `Warning: could not record install provenance: ${err instanceof Error ? err.message : String(err)} — 'mcx upgrade --check' will report this build as unverified.`,
    );
  }

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
    d.log(`${binDir}/{mcx,mcpd,mcpctl} now match ${release.version}`);
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

/**
 * Install `src`'s bytes at `dst` as a real file copy, atomically on POSIX:
 * copy to a sibling temp file (preserving `src`'s permissions, notably the
 * executable bit), then `rename()` over the old one. A process that already
 * has `dst` open (e.g. a running daemon executing its own binary) keeps
 * running against the detached old inode — rename never truncates or
 * rewrites a file a live process is using, and there is never a window
 * where `dst` is missing or half-written. This is a copy, never a symlink
 * — see the file header for why that distinction matters here (#3231).
 */
function copyAtomic(src: string, dst: string): void {
  const tmp = `${dst}.new-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    /* didn't exist */
  }
  copyFileSync(src, tmp);
  chmodSync(tmp, statSync(src).mode);
  renameSync(tmp, dst);
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
