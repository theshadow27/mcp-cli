/**
 * Runtime resolver for the `playwright` npm package.
 *
 * In compiled binaries (`bun build --compile`), the site-worker runs from
 * `/$bunfs/root/` — a read-only virtual FS with no `node_modules`. The
 * `--external playwright` flag defers resolution to runtime, but the bunfs
 * resolver can't find the package. This module resolves playwright from
 * real on-disk paths and auto-installs to a vendor directory on first use.
 *
 * See #1601 for the full backstory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserType } from "playwright";

const VENDOR_DIR = join(homedir(), ".mcp-cli", "vendor", "playwright");
const VENDOR_PKG = join(VENDOR_DIR, "node_modules", "playwright");

// Keep in sync with devDependencies in package.json.
const PLAYWRIGHT_VERSION = "1.59.1";

/**
 * Ordered list of on-disk paths where playwright might be installed.
 * The first one that exists wins. process.cwd() is intentionally omitted —
 * the daemon is long-lived and its cwd at startup is caller-dependent, so
 * using it would poison the cache with whatever project the user was in.
 */
export function playwrightCandidates(): string[] {
  const candidates = [VENDOR_PKG];

  if (process.env.BUN_INSTALL) {
    candidates.push(join(process.env.BUN_INSTALL, "install", "global", "node_modules", "playwright"));
  }

  return candidates;
}

// Promise deduplication: all concurrent callers share one in-flight resolution.
// On failure the promise is cleared so the next call can retry.
let pending: Promise<BrowserType> | null = null;

/**
 * Resolve the playwright `chromium` browser type from a real on-disk path.
 * Auto-installs to `~/.mcp-cli/vendor/playwright/` on first use if no
 * candidate path has playwright installed.
 */
export function resolvePlaywright(opts?: {
  candidates?: string[];
  install?: (vendorDir: string) => { exitCode: number; stderr: string } | Promise<{ exitCode: number; stderr: string }>;
  /** Override the path checked after a successful install. Defaults to VENDOR_PKG. For testing only. */
  vendorPkg?: string;
}): Promise<BrowserType> {
  if (!pending) {
    pending = doResolve(opts).catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

async function doResolve(opts?: {
  candidates?: string[];
  install?: (vendorDir: string) => { exitCode: number; stderr: string } | Promise<{ exitCode: number; stderr: string }>;
  vendorPkg?: string;
}): Promise<BrowserType> {
  const candidates = opts?.candidates ?? playwrightCandidates();

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const mod = await import(candidate);
        if (mod.chromium) return mod.chromium as BrowserType;
        // exists and loads but no chromium export — try next candidate
      } catch {
        // import failed — try next candidate
      }
    }
  }

  // No candidate found — auto-install to vendor dir.
  console.error("[site] playwright not found locally — installing to vendor dir…");

  const doInstall = opts?.install ?? _defaultInstall;
  const result = await doInstall(VENDOR_DIR);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to auto-install playwright (exit ${result.exitCode}): ${result.stderr.trim() || "(no output)"}. ` +
        `Install manually: cd ${VENDOR_DIR} && bun add playwright`,
    );
  }

  const resolvedVendorPkg = opts?.vendorPkg ?? VENDOR_PKG;
  if (!existsSync(resolvedVendorPkg)) {
    throw new Error(
      `playwright install succeeded but package not found at ${resolvedVendorPkg}. ` +
        `Install manually: cd ${VENDOR_DIR} && bun add playwright`,
    );
  }

  console.error("[site] playwright installed successfully");

  const mod = await import(resolvedVendorPkg);
  if (!mod.chromium) {
    throw new Error(`playwright installed but chromium export is missing at ${resolvedVendorPkg}`);
  }
  return mod.chromium as BrowserType;
}

/**
 * Locate the bun CLI binary. Tries (in order):
 *   1. PATH lookup via Bun.which
 *   2. $BUN_INSTALL/bin/bun
 *   3. ~/.bun/bin/bun (default bun install location)
 *
 * process.execPath is intentionally NOT used — in compiled binaries it points
 * to the mcpd binary itself, not the bun package manager CLI.
 *
 * Exported for testing only (injectable deps keep it unit-testable without
 * mock.module()).
 */
export function _resolveBunBinary(
  vendorDir: string,
  opts?: {
    which?: (name: string) => string | null;
    bunInstallEnv?: string | undefined;
    homeDir?: string;
  },
): string {
  const which = opts?.which ?? Bun.which.bind(Bun);
  // Use "in" check so callers can pass `bunInstallEnv: undefined` to suppress
  // the process.env.BUN_INSTALL fallback (needed for testing).
  const bunInstall = opts && "bunInstallEnv" in opts ? opts.bunInstallEnv : process.env.BUN_INSTALL;
  const home = opts?.homeDir ?? homedir();

  const fromPath = which("bun");
  if (fromPath) return fromPath;

  if (bunInstall) {
    const candidate = join(bunInstall, "bin", "bun");
    if (existsSync(candidate)) return candidate;
  }

  const homeDefault = join(home, ".bun", "bin", "bun");
  if (existsSync(homeDefault)) return homeDefault;

  throw new Error(`Install bun (https://bun.sh) and run: cd ${vendorDir} && bun add playwright`);
}

export async function _defaultInstall(
  vendorDir: string,
  bunBin?: string,
): Promise<{ exitCode: number; stderr: string }> {
  mkdirSync(vendorDir, { recursive: true });

  // Anchor bun so it doesn't walk up to an unrelated package.json.
  const pkgJson = join(vendorDir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, '{"name":"mcx-playwright-vendor","private":true}\n');
  }

  const bin = bunBin ?? _resolveBunBinary(vendorDir);

  // Bun.spawn() throws (ENOENT/EACCES) rather than returning a failed process
  // when the binary doesn't exist. Catch and wrap so callers always see the
  // actionable "Install manually" message instead of a raw spawn error.
  try {
    const proc = Bun.spawn([bin, "add", `playwright@${PLAYWRIGHT_VERSION}`], {
      cwd: vendorDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return {
      exitCode: proc.exitCode ?? 1,
      stderr: await new Response(proc.stderr).text(),
    };
  } catch (err) {
    throw new Error(
      `Failed to spawn bun to install playwright: ${err instanceof Error ? err.message : String(err)}. ` +
        `Install manually: cd ${vendorDir} && bun add playwright`,
      { cause: err },
    );
  }
}

/** Reset cached resolution — for testing only. */
export function _resetCache(): void {
  pending = null;
}
