/**
 * Site configuration loader.
 *
 * A site = a configured web app target with its own URL, credential pool,
 * named-call catalog, and optional wiggle script. Loaded from
 * `~/.mcp-cli/sites/<name>/config.json`, merged with any built-in seed
 * bundled at `site/seeds/<name>/config.json`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { siteConfigPath, sitePath, sitesDir } from "./paths";
import { BUILTIN_SEEDS } from "./seeds";

const SITE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Reject site names that could escape SITES_DIR (path traversal) or collide with special FS entries. */
export function validateSiteName(name: string): void {
  if (!name || typeof name !== "string") throw new Error("Site name is required");
  if (!SITE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid site name '${name}'. Must be alphanumeric (plus -/_), 1–64 chars, and start with a letter or digit.`,
    );
  }
}

export interface BrowserConfig {
  /** Browser engine adapter. Defaults to "playwright". */
  engine?: "playwright" | "webview";
  /** Profile directory name under sites/<name>/chromium/. Defaults to "default". */
  chromeProfile?: string;
}

export interface CaptureFilters {
  match: string[];
  skip: string[];
}

export interface SiteConfig {
  name: string;
  enabled: boolean;
  url: string;
  /** Hostname glob patterns (e.g. "*.example.com") matched against request URLs for credential routing. */
  domains: string[];
  /** Custom protocols to block in the browser (e.g. "msteams://") to keep users inside the tab. */
  blockProtocols?: string[];
  captureMode?: "off" | "filtered" | "firehose";
  captureFilters?: CaptureFilters;
  /** Path (relative to the site dir or built-in seed) to a JS keep-alive script. */
  wiggle?: string;
  /** Built-in seed name to fall back to if local files are missing. Defaults to the site name. */
  seed?: string;
  browser?: BrowserConfig;
}

export type PartialSiteConfig = Partial<SiteConfig>;

function loadBuiltinSeeds(): Record<string, PartialSiteConfig> {
  const seeds: Record<string, PartialSiteConfig> = {};
  for (const [name, data] of Object.entries(BUILTIN_SEEDS)) {
    seeds[name] = data.config;
  }
  return seeds;
}

function loadUserSiteConfig(site: string): PartialSiteConfig | null {
  const path = siteConfigPath(site);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PartialSiteConfig;
  } catch {
    return null;
  }
}

function mergeConfig(name: string, seed: PartialSiteConfig, user: PartialSiteConfig | null): SiteConfig {
  const merged: PartialSiteConfig = { ...seed, ...(user ?? {}) };
  return {
    name,
    enabled: merged.enabled ?? true,
    url: merged.url ?? "",
    domains: merged.domains ?? [],
    blockProtocols: merged.blockProtocols,
    captureMode: merged.captureMode,
    captureFilters: merged.captureFilters,
    wiggle: merged.wiggle,
    seed: merged.seed ?? name,
    browser: {
      engine: merged.browser?.engine ?? "playwright",
      chromeProfile: merged.browser?.chromeProfile ?? "default",
    },
  };
}

/** List all configured sites — both user-configured (under SITES_DIR) and built-in seeds. */
export function listSites(): SiteConfig[] {
  const seeds = loadBuiltinSeeds();
  const names = new Set<string>(Object.keys(seeds));

  const sitesRoot = sitesDir();
  if (existsSync(sitesRoot)) {
    for (const entry of readdirSync(sitesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  }

  const out: SiteConfig[] = [];
  for (const name of [...names].sort()) {
    out.push(mergeConfig(name, seeds[name] ?? {}, loadUserSiteConfig(name)));
  }
  return out;
}

/** Load a single site's config, merging built-in seed with user overrides. Returns null if neither exists. */
export function getSite(name: string): SiteConfig | null {
  const seeds = loadBuiltinSeeds();
  const user = loadUserSiteConfig(name);
  if (!seeds[name] && !user && !existsSync(sitePath(name))) return null;
  return mergeConfig(name, seeds[name] ?? {}, user);
}

/** Write (or overwrite) a site's user config. Creates the directory if needed. */
export function writeSiteConfig(name: string, config: PartialSiteConfig): void {
  validateSiteName(name);
  const path = siteConfigPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

/** Match a hostname against a glob pattern ("*.foo.com" matches "a.foo.com" and "a.b.foo.com"). */
export function domainMatches(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return false;
}

/** Return the site name whose domains match the given hostname, or null. */
export function getSiteForDomain(hostname: string): string | null {
  for (const site of listSites()) {
    if (!site.enabled) continue;
    for (const pattern of site.domains) {
      if (domainMatches(hostname, pattern)) return site.name;
    }
  }
  return null;
}

/** Resolve a site asset path (e.g. wiggle script) from the user's site dir. */
export function resolveSiteAsset(site: string, relPath: string): string | null {
  const userPath = join(sitePath(site), relPath);
  if (existsSync(userPath)) return userPath;
  return null;
}

/** Return the embedded wiggle script source for a built-in seed, or null. */
export function getBuiltinWiggleSource(seedName: string): string | null {
  return BUILTIN_SEEDS[seedName]?.wiggleSrc ?? null;
}
