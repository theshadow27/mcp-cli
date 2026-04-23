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

/**
 * Ordered list of on-disk paths where playwright might be installed.
 * The first one that exists wins.
 */
export function playwrightCandidates(): string[] {
  const candidates = [VENDOR_PKG];

  candidates.push(join(process.cwd(), "node_modules", "playwright"));

  if (process.env.BUN_INSTALL) {
    candidates.push(join(process.env.BUN_INSTALL, "install", "global", "node_modules", "playwright"));
  }

  return candidates;
}

let cached: BrowserType | null = null;

/**
 * Resolve the playwright `chromium` browser type from a real on-disk path.
 * Auto-installs to `~/.mcp-cli/vendor/playwright/` on first use if no
 * candidate path has playwright installed.
 */
export async function resolvePlaywright(opts?: {
  candidates?: string[];
  install?: (vendorDir: string) => { exitCode: number; stderr: string };
}): Promise<BrowserType> {
  if (cached) return cached;

  const candidates = opts?.candidates ?? playwrightCandidates();

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const mod = await import(candidate);
        cached = mod.chromium as BrowserType;
        return cached;
      } catch {
        // Path exists but import failed — try next candidate.
      }
    }
  }

  // No candidate found — auto-install to vendor dir.
  console.log("[site] playwright not found locally — installing to vendor dir…");

  const doInstall = opts?.install ?? defaultInstall;
  const result = doInstall(VENDOR_DIR);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to auto-install playwright (exit ${result.exitCode}): ${result.stderr.trim() || "(no output)"}. ` +
        `Install manually: bun add playwright --cwd ${VENDOR_DIR}`,
    );
  }

  if (!existsSync(VENDOR_PKG)) {
    throw new Error(
      `playwright install succeeded but package not found at ${VENDOR_PKG}. ` +
        `Install manually: bun add playwright --cwd ${VENDOR_DIR}`,
    );
  }

  console.log("[site] playwright installed successfully");

  const mod = await import(VENDOR_PKG);
  cached = mod.chromium as BrowserType;
  return cached;
}

function defaultInstall(vendorDir: string): { exitCode: number; stderr: string } {
  mkdirSync(vendorDir, { recursive: true });

  // Anchor bun so it doesn't walk up to an unrelated package.json.
  const pkgJson = join(vendorDir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, '{"private":true}\n');
  }

  const proc = Bun.spawnSync(["bun", "add", "playwright"], {
    cwd: vendorDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
  };
}

/** Reset cached module — for testing only. */
export function _resetCache(): void {
  cached = null;
}
