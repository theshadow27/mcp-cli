/**
 * Self-upgrade utilities for mcx CLI binaries.
 *
 * Handles version comparison, asset selection by platform/arch,
 * and a daily update-check cache to avoid hammering GitHub.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_COMMIT, options } from "./constants";
import { spawnCapture } from "./subprocess";

const REPO = "theshadow27/mcp-cli";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** How long to cache the update-check result (ms) — 24 hours */
const CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
  tag: string;
  version: string;
  assets: Array<{ name: string; url: string; size: number }>;
}

/**
 * Where the running binary came from (#3260).
 *
 * - `release` — installed from an official release by `mcx upgrade` or
 *   `install.sh`, proven by the install marker matching this executable.
 * - `dev` — provably not a release artifact (built from an uncommitted tree,
 *   an uncompiled `-dev` binary, or a version no release has ever carried).
 * - `unknown` — genuinely undecidable from what the binary can observe. This
 *   is a first-class answer, not a failure: reporting a confident falsehood
 *   is strictly worse than admitting the ambiguity (#3260 was exactly that
 *   falsehood, in the "release artifact" direction).
 */
export type BuildProvenance = "release" | "dev" | "unknown";

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  asset: string | null;
  /**
   * Provenance of the running binary — recorded at install time, never
   * inferred from the version string.
   *
   * The predecessor of this field was `devBuild`, computed as
   * `currentVersion.includes("+")`. That was wrong in the worst direction:
   * `scripts/build.ts` stamps `+epoch` on *every* compiled artifact, release
   * CI builds included, so a genuinely-installed release running
   * `mcx upgrade --check` at its own version was told it was a dev build.
   * `BUILD_VERSION` alone cannot answer this question — the epoch says when a
   * binary was compiled, and `BUILD_COMMIT` (#3264) says from what source, but
   * neither says through which distribution channel it arrived. Only the
   * installer knows that, so the installer is what records it.
   */
  provenance: BuildProvenance;
}

/**
 * Provenance record written by the installer (`mcx upgrade`, `install.sh`)
 * and read back by `checkForUpdate`.
 *
 * Sizes are recorded so that overwriting an installed binary in place (say,
 * a `bun build` output copied over `~/.mcp-cli/bin/mcx`) stops matching:
 * the marker attests to specific installed *files*, not merely to a path
 * having been written once. `wc -c` and `statSync().size` agree, which keeps
 * the shell installer and this reader on the same definition.
 */
export interface InstallMarker {
  /** Release version installed, without a leading `v` (e.g. `2.0.0`). */
  version: string;
  /** Unix epoch seconds at install time. */
  installedAt: number;
  /** Which installer wrote this — `mcx-upgrade` or `install.sh`. */
  source: string;
  binaries: Array<{ path: string; size: number }>;
}

/** Identity of the running executable, as seen by the provenance check. */
export interface ExecutableIdentity {
  /** Candidate paths for this executable (raw and resolved — `$HOME` may be a symlink). */
  paths: string[];
  size: number;
}

export interface ProvenanceInput {
  /** Running binary's `BUILD_VERSION`. */
  current: string;
  /** Latest release version. */
  latest: string;
  /** Running binary's `BUILD_COMMIT` (#3264), or null when unstamped. */
  commit: string | null;
  marker: InstallMarker | null;
  exe: ExecutableIdentity | null;
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
 * Compare two semver-ish version strings (standard convention).
 * Returns positive if a > b, negative if b > a, 0 if equal.
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
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Equal core versions: a pre-release is less than no pre-release
  if (pa.prerelease !== null && pb.prerelease === null) return -1; // a < b
  if (pa.prerelease === null && pb.prerelease !== null) return 1; // a > b
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

/**
 * Install provenance marker path — `~/.mcp-cli/bin/versions/.installed`.
 *
 * Lives beside the versioned install tree that `mcx upgrade` owns. Read at
 * call time (not module load) because tests and `MCP_CLI_DIR` relocate the
 * state directory.
 *
 * `scripts/install.sh` writes the same file, at the same path, when it
 * installs to the default `$HOME/.mcp-cli/bin`. Installing elsewhere via
 * `MCP_CLI_INSTALL_DIR` puts the marker somewhere this reader won't look, so
 * provenance degrades to `unknown` — the honest answer, not a false one.
 */
export function installMarkerPath(): string {
  return join(options.MCP_CLI_DIR, "bin", "versions", ".installed");
}

/** Read the install provenance marker, or null if absent/corrupt. */
export function readInstallMarker(): InstallMarker | null {
  try {
    const raw = JSON.parse(readFileSync(installMarkerPath(), "utf-8")) as InstallMarker;
    if (typeof raw.version !== "string" || !Array.isArray(raw.binaries)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Record that `version` was installed from an official release at `paths`.
 *
 * Sizes are stat'd here rather than taken on trust, so the marker always
 * describes the bytes actually on disk at install time. Paths that don't
 * exist are skipped — a partial install records what it managed to install.
 */
export function writeInstallMarker(version: string, source: string, paths: string[]): void {
  const binaries: InstallMarker["binaries"] = [];
  for (const path of paths) {
    try {
      binaries.push({ path, size: statSync(path).size });
    } catch {
      /* not installed (e.g. an optional binary missing from the tarball) */
    }
  }
  const marker: InstallMarker = {
    version: version.replace(/^v/, ""),
    installedAt: Math.floor(Date.now() / 1000),
    source,
    binaries,
  };
  const markerPath = installMarkerPath();
  mkdirSync(join(markerPath, ".."), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, "utf-8");
}

/** Identify the running executable for a provenance check. Null if unreadable. */
export function currentExecutable(execPath: string = process.execPath): ExecutableIdentity | null {
  try {
    const size = statSync(execPath).size;
    const paths = [execPath];
    try {
      const resolved = realpathSync(execPath);
      if (resolved !== execPath) paths.push(resolved);
    } catch {
      /* unresolvable symlink — the raw path is still a valid candidate */
    }
    return { paths, size };
  } catch {
    return null;
  }
}

/** True when the marker attests to the exact executable that is running. */
function markerCoversExecutable(marker: InstallMarker, exe: ExecutableIdentity): boolean {
  return marker.binaries.some((b) => b.size === exe.size && exe.paths.includes(b.path));
}

/**
 * Decide where the running binary came from. Pure — all IO is done by the
 * caller — so every branch below is directly testable.
 *
 * Ordered most-conclusive first:
 *
 * 1. The install marker attests to this exact executable, at this version →
 *    `release`. This is the only positive proof available; nothing derivable
 *    from `BUILD_VERSION` can establish it.
 * 2. `BUILD_COMMIT` reports `-dirty`/`-unknown` → `dev`. Release CI builds
 *    from a clean checkout, so an unclean (or unverifiable) source tree can
 *    never be an official artifact.
 * 3. `current` carries a pre-release suffix (`2.0.0-dev`, uncompiled
 *    `bun dev:mcx`) → `dev`.
 * 4. `current` is strictly newer than the latest release → `dev`. No release
 *    ever carried this version, so no install of one could have produced it.
 * 5. Otherwise → `unknown`. Typically a compiled binary at a released version
 *    with no marker: installed before markers existed, installed to a custom
 *    directory, or built locally from the release tag. These are genuinely
 *    indistinguishable from inside the binary, and #3260 is what happens when
 *    you guess anyway.
 */
export function resolveProvenance(input: ProvenanceInput): BuildProvenance {
  const { current, latest, commit, marker, exe } = input;

  if (marker && exe && markerCoversExecutable(marker, exe) && compareVersions(current, marker.version) === 0) {
    return "release";
  }
  if (commit?.endsWith("-dirty") || commit?.endsWith("-unknown")) return "dev";
  if (current.replace(/^v/, "").split("+")[0].includes("-")) return "dev";
  if (compareVersions(current, latest) > 0) return "dev";
  return "unknown";
}

/** Resolve provenance for the running process, reading marker + executable from disk. */
function defaultProvenance(current: string, latest: string): BuildProvenance {
  return resolveProvenance({
    current,
    latest,
    commit: BUILD_COMMIT,
    marker: readInstallMarker(),
    exe: currentExecutable(),
  });
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
    const result = await spawnCapture("gh", ["auth", "token"]);
    if (result.ok && result.stdout.trim()) return result.stdout.trim();
  } catch {
    /* gh not installed */
  }
  return null;
}

export type CheckForUpdateDeps = Partial<
  FetchReleaseDeps & {
    skipCache: boolean;
    /** Override provenance resolution (tests inject; production reads disk). */
    provenance: (current: string, latest: string) => BuildProvenance;
  }
>;

/**
 * Check for available update, using cache when fresh.
 */
export async function checkForUpdate(currentVersion: string, deps?: CheckForUpdateDeps): Promise<UpdateCheckResult> {
  const platform = process.platform;
  const arch = process.arch;
  const asset = selectAsset(platform, arch);
  const provenanceOf = deps?.provenance ?? defaultProvenance;

  if (!deps?.skipCache) {
    const cached = readCheckCache();
    if (cached) {
      return {
        current: currentVersion,
        latest: cached.latest,
        updateAvailable: compareVersions(cached.latest, currentVersion) > 0,
        asset,
        provenance: provenanceOf(currentVersion, cached.latest),
      };
    }
  }

  const release = await fetchLatestRelease(deps);
  writeCheckCache(release.version);

  return {
    current: currentVersion,
    latest: release.version,
    updateAvailable: compareVersions(release.version, currentVersion) > 0,
    asset,
    provenance: provenanceOf(currentVersion, release.version),
  };
}
