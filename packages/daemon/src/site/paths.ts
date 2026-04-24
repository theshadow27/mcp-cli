/**
 * Filesystem paths for the `site` backend.
 *
 * Everything lives under options.SITES_DIR (`~/.mcp-cli/sites/` by default).
 * Per-site directory layout:
 *   sites/<name>/
 *     config.json     — user-authored overrides merged with built-in seed
 *     catalog.json    — named HTTP calls
 *     captures/       — API sniffer output
 *     chromium/<profile>/  — browser user data (one dir per chromeProfile)
 */

import { join } from "node:path";
import { options } from "@mcp-cli/core";

export function sitesDir(): string {
  return options.SITES_DIR;
}

export function sitePath(site: string): string {
  return join(sitesDir(), site);
}

export function siteConfigPath(site: string): string {
  return join(sitePath(site), "config.json");
}

export function siteCatalogPath(site: string): string {
  return join(sitePath(site), "catalog.json");
}

export function siteCapturesDir(site: string): string {
  return join(sitePath(site), "captures");
}

export function siteBrowserProfileDir(site: string, profile: string): string {
  if (/[/\\]/.test(profile) || profile.split("/").some((seg) => seg === "..")) {
    throw new Error(
      `Invalid chromeProfile: must be a simple name (no path separators or '..' segments); got: ${profile}`,
    );
  }
  return join(sitePath(site), "chromium", profile);
}
