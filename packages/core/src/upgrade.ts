/**
 * Self-upgrade utilities for mcx CLI binaries.
 *
 * Handles version comparison, asset selection by platform/arch,
 * and a daily update-check cache to avoid hammering GitHub.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { options } from "./constants";

const REPO = "theshadow27/mcp-cli";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** How long to cache the update-check result (ms) — 24 hours */
const CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
  tag: string;
  version: string;
  assets: Array<{ name: string; url: string; size: number }>;
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  asset: string | null;
}

export interface UpdateCheckCache {
  checkedAt: number;
  latest: string;
}

/** Platform + arch → tarball asset name */
const ASSET_MAP: Record<string, string> = {
  "darwin-arm64": "mcx-darwin-arm64.tar.gz",
  "darwin-x64": "mcx-darwin-x64.tar.gz",
  "linux-x64": "mcx-linux-x64.tar.gz",
  "linux-arm64": "mcx-linux-arm64.tar.gz",
};

/**
 * Select the correct release asset name for the current platform.
 * Returns null if the platform/arch combo isn't supported.
 */
export function selectAsset(platform: string = process.platform, arch: string = process.arch): string | null {
  return ASSET_MAP[`${platform}-${arch}`] ?? null;
}

/**
 * Compare two semver-ish version strings.
 * Returns positive if b > a, negative if a > b, 0 if equal.
 * Strips leading 'v' and ignores build metadata (+epoch).
 * Pre-release versions (e.g. 1.0.0-dev) are ordered before their
 * release counterparts per semver: 1.0.0-dev < 1.0.0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; prerelease: string | null } => {
    const stripped = v.replace(/^v/, "").split("+")[0];
    const dashIdx = stripped.indexOf("-");
    const core = dashIdx === -1 ? stripped : stripped.slice(0, dashIdx);
    const prerelease = dashIdx === -1 ? null : stripped.slice(dashIdx + 1);
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      prerelease,
    };
  };

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.parts.length, pb.parts.length);

  for (let i = 0; i < len; i++) {
    const diff = (pb.parts[i] ?? 0) - (pa.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Equal core versions: a pre-release is less than no pre-release
  if (pa.prerelease !== null && pb.prerelease === null) return 1; // b > a
  if (pa.prerelease === null && pb.prerelease !== null) return -1; // a > b
  return 0;
}

function cachePath(): string {
  return join(options.MCP_CLI_DIR, "update-check.json");
}

/** Read the cached update-check result, if fresh. */
export function readCheckCache(): UpdateCheckCache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf-8")) as UpdateCheckCache;
    if (Date.now() - raw.checkedAt < CHECK_CACHE_TTL_MS) return raw;
  } catch {
    /* missing or corrupt */
  }
  return null;
}

/** Write update-check cache. */
export function writeCheckCache(latest: string): void {
  const data: UpdateCheckCache = { checkedAt: Date.now(), latest };
  writeFileSync(cachePath(), JSON.stringify(data), "utf-8");
}

export interface FetchReleaseDeps {
  fetch: typeof globalThis.fetch;
  ghToken?: string;
}

/**
 * Fetch the latest release from GitHub API.
 * Falls back to `gh auth token` if unauthenticated request gets 403.
 * The `retried` flag prevents infinite recursion if the token doesn't help.
 */
export async function fetchLatestRelease(deps?: Partial<FetchReleaseDeps>, retried = false): Promise<ReleaseInfo> {
  const fetchFn = deps?.fetch ?? globalThis.fetch;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mcx-upgrade",
  };
  if (deps?.ghToken) {
    headers.Authorization = `Bearer ${deps.ghToken}`;
  }

  const resp = await fetchFn(RELEASES_API, { headers });

  if (resp.status === 403 && !deps?.ghToken && !retried) {
    // Try with gh auth token (once)
    const token = await getGhToken();
    if (token) {
      return fetchLatestRelease({ ...deps, fetch: fetchFn, ghToken: token }, true);
    }
  }

  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  };

  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^v/, ""),
    assets: data.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

async function getGhToken(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && text.trim()) return text.trim();
  } catch {
    /* gh not installed */
  }
  return null;
}

/**
 * Check for available update, using cache when fresh.
 */
export async function checkForUpdate(
  currentVersion: string,
  deps?: Partial<FetchReleaseDeps & { skipCache: boolean }>,
): Promise<UpdateCheckResult> {
  const platform = process.platform;
  const arch = process.arch;
  const asset = selectAsset(platform, arch);

  if (!deps?.skipCache) {
    const cached = readCheckCache();
    if (cached) {
      return {
        current: currentVersion,
        latest: cached.latest,
        updateAvailable: compareVersions(currentVersion, cached.latest) > 0,
        asset,
      };
    }
  }

  const release = await fetchLatestRelease(deps);
  writeCheckCache(release.version);

  return {
    current: currentVersion,
    latest: release.version,
    updateAvailable: compareVersions(currentVersion, release.version) > 0,
    asset,
  };
}
