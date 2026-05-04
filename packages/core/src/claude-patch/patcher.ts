/**
 * Patched-claude binary store + orchestration.
 *
 * Hard rules (per issue #1808):
 *  - Never modify the user's installed `claude` binary in place. Always
 *    copy first; patch + re-sign the copy.
 *  - The patched copy lives under `~/.mcp-cli/claude-patched/` and has
 *    sidecar metadata so we can detect when the source has been auto-updated
 *    (and therefore the patched copy is stale).
 *  - The strategy registry is the only place version-specific patch logic
 *    lives. The orchestrator stays version-agnostic.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { options } from "../constants";
import { sha256Hex } from "../manifest-lock";
import { type PatchStrategy, resolveStrategy } from "./strategies";

export interface PatcherDeps {
  /** Resolve the version of a claude binary. Default: spawn `<bin> --version`. */
  versionResolver: (binPath: string) => Promise<string>;
  /** Extract entitlements from a signed Mach-O binary. macOS only. */
  extractEntitlements: (binPath: string) => Promise<string>;
  /** Re-sign a binary with an ad-hoc signature using extracted entitlements. macOS only. */
  resignBinary: (binPath: string, entitlementsPath: string) => Promise<void>;
  /** Run a smoke test on the patched binary (e.g. `<bin> --version` exits 0). */
  smokeTest: (binPath: string) => Promise<void>;
  /** Read source binary bytes. Override in tests. */
  readBytes: (path: string) => Uint8Array;
  /** Write patched binary bytes (atomic via temp+rename). Override in tests. */
  writeBytesAtomic: (path: string, bytes: Uint8Array) => void;
  /** Strategy registry. Defaults to BUILTIN_STRATEGIES. */
  strategies?: readonly PatchStrategy[];
}

export interface UpdateOptions {
  /** Path to source claude binary. Resolved via `which claude` if omitted. */
  sourcePath?: string;
  /** Override the patched-binary store directory. Defaults to options.CLAUDE_PATCHED_DIR. */
  storeDir?: string;
  /** Force re-patch even if the cached patched copy looks current. */
  force?: boolean;
}

export type UpdateOutcome =
  | {
      status: "patched" | "already-current";
      version: string;
      strategyId: string;
      sourcePath: string;
      sourceHash: string;
      patchedPath: string;
      currentLink: string;
    }
  | {
      status: "noop";
      version: string;
      strategyId: string;
      sourcePath: string;
      sourceHash: string;
      reason: string;
    }
  | {
      status: "unsupported";
      version: string;
      sourcePath: string;
      sourceHash: string;
      reason: string;
    };

export interface PatchedMeta {
  version: string;
  strategyId: string;
  sourcePath: string;
  sourceHash: string;
  signedAt: string;
}

function patchedPathFor(storeDir: string, version: string): string {
  return join(storeDir, `${version}.patched`);
}

function metaPathFor(storeDir: string, version: string): string {
  return join(storeDir, `${version}.meta.json`);
}

function currentLinkFor(storeDir: string): string {
  return join(storeDir, "current");
}

function readMeta(path: string): PatchedMeta | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as PatchedMeta;
  } catch {
    return null;
  }
}

function writeMeta(path: string, meta: PatchedMeta): void {
  writeFileSync(path, JSON.stringify(meta, null, 2), { mode: 0o644 });
}

/**
 * Update the symlink at `linkPath` to point to `target` atomically.
 * Atomic rename via temp symlink — works on POSIX; on platforms without
 * symlink support this falls back to a pointer file containing the path.
 */
function updateCurrentLink(linkPath: string, target: string): void {
  const tmp = `${linkPath}.tmp.${process.pid}`;
  // Best-effort cleanup of any stale temp from a crashed previous run.
  try {
    rmSync(tmp, { force: true });
  } catch {
    // ignore
  }
  try {
    symlinkSync(target, tmp);
    renameSync(tmp, linkPath);
  } catch {
    // Symlink may fail on some filesystems; fall back to a plain pointer file.
    // Remove any partial symlink first — writeFileSync follows symlinks, so
    // writing through a dangling symlink would corrupt the target binary.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, target, { mode: 0o644 });
    renameSync(tmp, linkPath);
  }
}

/**
 * Default version resolver: spawn `<binPath> --version`, expect "X.Y.Z (...)" or similar.
 */
export async function defaultVersionResolver(binPath: string): Promise<string> {
  const result = spawnSync(binPath, ["--version"], { encoding: "utf-8", timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`${binPath} --version exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  const out = (result.stdout || "").trim();
  // Match the leading version token; tolerate suffixes like "(Claude Code)".
  const m = out.match(/^(\d+(?:\.\d+){1,3})/);
  if (!m) throw new Error(`Could not parse version from: ${out}`);
  return m[1];
}

/**
 * Extract entitlements from a signed Mach-O binary into an XML plist string.
 * Wraps `codesign -d --entitlements :- <bin>`. macOS only.
 */
export async function defaultExtractEntitlements(binPath: string): Promise<string> {
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", binPath], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  // codesign writes the plist to stdout. Empty stdout is acceptable (no entitlements).
  if (result.status !== 0) {
    const stderr = result.stderr || "";
    // codesign sometimes returns non-zero with the plist still on stdout; allow that.
    if (!result.stdout) {
      throw new Error(`codesign -d failed: ${stderr.trim() || `exit ${result.status}`}`);
    }
  }
  return result.stdout || "";
}

/**
 * Re-sign a binary with an ad-hoc signature, preserving entitlements.
 * Wraps `codesign --force --sign - --options=runtime --entitlements <plist> <bin>`.
 */
export async function defaultResignBinary(binPath: string, entitlementsPath: string): Promise<void> {
  const result = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--options=runtime", "--entitlements", entitlementsPath, binPath],
    { encoding: "utf-8", timeout: 30_000 },
  );
  if (result.error) {
    throw new Error(`codesign --force failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`codesign --force failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
}

/**
 * Run `<binPath> --version` and assert exit 0. Catches the common "ad-hoc
 * signing wrong on this filesystem / wrong arch" failure modes before we
 * commit the patched copy.
 */
export async function defaultSmokeTest(binPath: string): Promise<void> {
  const result = spawnSync(binPath, ["--version"], { encoding: "utf-8", timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`smoke test failed: ${binPath} --version exited ${result.status}`);
  }
}

export const DEFAULT_DEPS: PatcherDeps = {
  versionResolver: defaultVersionResolver,
  extractEntitlements: defaultExtractEntitlements,
  resignBinary: defaultResignBinary,
  smokeTest: defaultSmokeTest,
  readBytes: (path) => new Uint8Array(readFileSync(path)),
  writeBytesAtomic: (path, bytes) => {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, bytes, { mode: 0o755 });
    renameSync(tmp, path);
  },
};

/**
 * Resolve the path to the claude binary mcx should use.
 *
 * Lookup order:
 *   1. `MCX_CLAUDE_BINARY` env — per-process override. Useful for one-off
 *      testing or scripts that want to point at a specific binary without
 *      mutating persistent config.
 *   2. `claudeBinary` in `~/.mcp-cli/config.json` — persistent override. Lets
 *      users pin mcx-spawned workers to a known-good version (e.g. an
 *      archived 2.1.119) while leaving their interactive `claude` on PATH
 *      free to auto-update. Set via `mcx config set claude-binary <path>`.
 *      Useful when a new claude release introduces a Remote-Control gate
 *      that mcx hasn't yet caught up to (see #1808 / strategies.ts).
 *   3. `which claude` on PATH — default for regular use.
 *
 * Returns null if none resolves. Both overrides are rejected if the file
 * doesn't exist, so a stale value fails loudly rather than silently falling
 * back to PATH.
 *
 * The config-file lookup is best-effort: if the config file is missing or
 * malformed, we silently fall through to PATH rather than throwing.
 *
 * `configPathOverride` is for tests — production callers pass nothing and
 * the real `~/.mcp-cli/config.json` is read.
 */
export function resolveSourceClaudePath(configPathOverride?: string): string | null {
  const envOverride = process.env.MCX_CLAUDE_BINARY?.trim();
  if (envOverride) {
    if (existsSync(envOverride)) return envOverride;
    throw new Error(
      `MCX_CLAUDE_BINARY="${envOverride}" does not exist. Unset it or point it at an installed claude binary.`,
    );
  }

  const configOverride = readConfigClaudeBinary(configPathOverride ?? options.MCP_CLI_CONFIG_PATH)?.trim();
  if (configOverride) {
    if (existsSync(configOverride)) return configOverride;
    throw new Error(
      `claude-binary in ~/.mcp-cli/config.json points at "${configOverride}", which does not exist. Update or unset via \`mcx config set claude-binary <path>\`.`,
    );
  }

  const r = spawnSync("which", ["claude"], { encoding: "utf-8", timeout: 5_000 });
  if (r.status !== 0) return null;
  const path = (r.stdout || "").trim();
  return path || null;
}

/**
 * Read `claudeBinary` from the CLI config file. Returns null on any error
 * (missing file, malformed JSON, missing field) — callers fall through to
 * the next resolution step rather than failing.
 *
 * We read the file directly here instead of importing `readCliConfig` to
 * avoid a circular dep (cli-config → telemetry → patcher).
 */
function readConfigClaudeBinary(configPath: string): string | null {
  try {
    const text = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(text) as { claudeBinary?: unknown };
    return typeof parsed.claudeBinary === "string" ? parsed.claudeBinary : null;
  } catch {
    return null;
  }
}

/**
 * Update the patched-claude store: detect the user's claude version, look
 * up the matching strategy, copy + patch + re-sign if needed. Idempotent.
 *
 * Never modifies the source binary. The source path is opened read-only.
 */
export async function updatePatchedClaude(
  opts: UpdateOptions = {},
  depsOverride: Partial<PatcherDeps> = {},
): Promise<UpdateOutcome> {
  const deps: PatcherDeps = { ...DEFAULT_DEPS, ...depsOverride };
  const sourcePath = opts.sourcePath ?? resolveSourceClaudePath();
  if (!sourcePath) {
    throw new Error("Could not locate `claude` on PATH. Set sourcePath or install Claude Code.");
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`Source claude binary not found: ${sourcePath}`);
  }
  const storeDir = opts.storeDir ?? options.CLAUDE_PATCHED_DIR;
  mkdirSync(storeDir, { recursive: true });

  const sourceBytes = deps.readBytes(sourcePath);
  const sourceHash = sha256Hex(sourceBytes);
  const version = await deps.versionResolver(sourcePath);

  const strategy = resolveStrategy(version, deps.strategies);
  if (!strategy) {
    return {
      status: "unsupported",
      version,
      sourcePath,
      sourceHash,
      reason: `No patch strategy registered for claude ${version}. File an issue at https://github.com/theshadow27/mcp-cli/issues with the version and the output of \`claude --version\`.`,
    };
  }

  // Noop strategies don't write anything to the store — they signal that the
  // caller should just spawn the source binary directly.
  if (strategy.id.startsWith("noop")) {
    return {
      status: "noop",
      version,
      strategyId: strategy.id,
      sourcePath,
      sourceHash,
      reason: strategy.description,
    };
  }

  const patchedPath = patchedPathFor(storeDir, version);
  const metaPath = metaPathFor(storeDir, version);
  const linkPath = currentLinkFor(storeDir);

  // Idempotency: if the cached patched copy matches this source, skip.
  if (!opts.force) {
    const existing = readMeta(metaPath);
    if (
      existing &&
      existing.sourceHash === sourceHash &&
      existing.strategyId === strategy.id &&
      existsSync(patchedPath)
    ) {
      // Refresh the current link in case it drifted.
      updateCurrentLink(linkPath, patchedPath);
      return {
        status: "already-current",
        version,
        strategyId: strategy.id,
        sourcePath,
        sourceHash,
        patchedPath,
        currentLink: linkPath,
      };
    }
  }

  // Apply the strategy.
  const patched = strategy.apply(sourceBytes);
  if (patched.length !== sourceBytes.length) {
    throw new Error(
      `strategy ${strategy.id} produced ${patched.length} bytes from ${sourceBytes.length} (must be length-preserving)`,
    );
  }
  const validation = strategy.validate(patched);
  if (!validation.ok) {
    throw new Error(`strategy ${strategy.id} validation failed: ${validation.reason}`);
  }

  // Stage to a temporary path so any failure (entitlements extraction,
  // resign, smoke test, or final promote) doesn't leave a broken binary
  // at the published path or an orphaned staging file.
  const stagingPath = `${patchedPath}.staging.${process.pid}`;
  deps.writeBytesAtomic(stagingPath, patched);
  chmodSync(stagingPath, 0o755);
  try {
    const entitlements = await deps.extractEntitlements(sourcePath);
    const entPath = join(tmpdir(), `mcx-entitlements-${process.pid}-${Date.now()}.plist`);
    writeFileSync(entPath, entitlements, { mode: 0o600 });
    try {
      await deps.resignBinary(stagingPath, entPath);
    } finally {
      try {
        rmSync(entPath, { force: true });
      } catch {
        // ignore
      }
    }

    await deps.smokeTest(stagingPath);
    renameSync(stagingPath, patchedPath);
  } catch (err) {
    rmSync(stagingPath, { force: true });
    throw err;
  }

  // Write metadata + update current link last (atomicity: if anything above
  // fails, the previous current link still points at the previous patched copy).
  const meta: PatchedMeta = {
    version,
    strategyId: strategy.id,
    sourcePath,
    sourceHash,
    signedAt: new Date().toISOString(),
  };
  writeMeta(metaPath, meta);
  updateCurrentLink(linkPath, patchedPath);

  return {
    status: "patched",
    version,
    strategyId: strategy.id,
    sourcePath,
    sourceHash,
    patchedPath,
    currentLink: linkPath,
  };
}

/**
 * Read the metadata for the currently-active patched binary, if any.
 * Returns null if no patched copy is registered (caller should spawn the
 * source binary directly, falling back to the failure mode in #1808).
 */
export function readCurrentPatchedMeta(storeDir?: string): PatchedMeta | null {
  const dir = storeDir ?? options.CLAUDE_PATCHED_DIR;
  const link = currentLinkFor(dir);
  if (!existsSync(link)) return null;

  // Resolve the link to the patched binary, then look up its sibling meta.json.
  let target: string;
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) {
      target = readlinkSync(link);
      if (!target.startsWith("/")) target = join(dirname(link), target);
    } else {
      // Pointer file fallback (see updateCurrentLink).
      target = readFileSync(link, "utf-8").trim();
    }
  } catch {
    return null;
  }

  // The patched binary is named "<version>.patched"; meta is "<version>.meta.json".
  const base = target.replace(/\.patched$/, "");
  return readMeta(`${base}.meta.json`);
}
