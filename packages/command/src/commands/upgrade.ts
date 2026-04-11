/**
 * `mcx upgrade` — download and install latest mcx release binaries.
 *
 * Flags:
 *   --check       Check for update without installing
 *   --yes / -y    Skip confirmation prompt
 *   --json / -j   JSON output
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION, options } from "@mcp-cli/core";
import {
  type FetchReleaseDeps,
  type ReleaseInfo,
  type UpdateCheckResult,
  checkForUpdate,
  fetchLatestRelease,
  selectAsset,
} from "@mcp-cli/core";
import { printError } from "../output";

export interface UpgradeDeps {
  version: string;
  execPath: string;
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
  version: VERSION,
  execPath: process.execPath,
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

  if (parsed.check) {
    await runCheck(d, parsed.json);
    return;
  }

  await runUpgrade(d, parsed);
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
    d.log(`Up to date (${result.current})`);
  }
}

async function runUpgrade(d: UpgradeDeps, parsed: ParsedArgs): Promise<void> {
  const assetName = d.selectAsset();
  if (!assetName) {
    printError(`Unsupported platform: ${process.platform}-${process.arch}`);
    process.exitCode = 1;
    return;
  }

  d.error("Checking for updates...");
  const result = await d.checkForUpdate(d.version, { fetch: d.fetch, skipCache: true });

  if (!result.updateAvailable) {
    if (parsed.json) {
      d.log(JSON.stringify({ status: "up_to_date", version: result.current }, null, 2));
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
    printError(`Asset ${assetName} not found in release ${release.tag}`);
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
    printError(`Download failed: HTTP ${resp.status}`);
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
    printError(`Extraction failed (exit ${tarExit}): ${stderr.trim()}`);
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Verify staged binaries
  const stagedMcx = join(stageDir, "mcx");
  const stagedMcpd = join(stageDir, "mcpd");
  const stagedMcpctl = join(stageDir, "mcpctl");

  if (!existsSync(stagedMcx)) {
    printError("Staged mcx binary not found after extraction");
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  d.error("Verifying staged binary...");
  const verify = d.spawn([stagedMcx, "version", "--json"], { stdout: "pipe", stderr: "ignore" });
  const verifyExit = await verify.exited;
  if (verifyExit !== 0) {
    printError(`Verification failed: staged mcx exited with ${verifyExit}`);
    cleanup(stageDir);
    process.exitCode = 1;
    return;
  }

  // Atomic swap: rename staged binaries over existing ones
  const installDir = dirname(d.execPath);
  d.error(`Installing to ${installDir}...`);

  const binaries: Array<[string, string]> = [
    [stagedMcx, join(installDir, "mcx")],
    [stagedMcpd, join(installDir, "mcpd")],
    [stagedMcpctl, join(installDir, "mcpctl")],
  ];

  for (const [staged, target] of binaries) {
    if (existsSync(staged)) {
      renameSync(staged, target);
    }
  }

  cleanup(stageDir);

  if (parsed.json) {
    d.log(JSON.stringify({ status: "updated", from: result.current, to: result.latest }, null, 2));
  } else {
    d.log(`Updated ${result.current} → ${result.latest}`);
    d.log("Restart daemon to use new version: mcx daemon restart");
  }
}

function cleanup(stageDir: string): void {
  try {
    rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
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
