/**
 * Resolve the claude binary that mcpd should spawn — and decide whether to
 * front it with a TLS WSS listener or the legacy plain ws:// listener.
 *
 * Three terminal states:
 *
 *   1. **noop** — the user's claude is older than 2.1.120 (the version that
 *      added the `--sdk-url` host allowlist). We spawn the user's binary
 *      directly with `ws://localhost:<port>/...`. No patching, no TLS, no
 *      change from pre-#1808 behavior.
 *
 *   2. **patched** — the user's claude is 2.1.120+ AND a fresh patched copy
 *      exists in `~/.mcp-cli/claude-patched/`. We spawn the patched copy
 *      with `wss://[::1]:<port>/...` and `NODE_TLS_REJECT_UNAUTHORIZED=0`
 *      in the env. Strict-trust upgrade tracked in #1829.
 *
 *   3. **error** — the user's claude is 2.1.120+ but no patched copy exists
 *      (or the cached one is stale because claude auto-updated). We refuse
 *      to spawn with a clear actionable error pointing at
 *      `mcx claude patch-update`. The daemon stays up; only `claude_spawn`
 *      tool calls fail.
 *
 * Resolution is eager (runs once at worker startup) but the worker still
 * starts even on error — the daemon needs to keep handling read-only
 * operations (list / log / wait) for any sessions already in flight.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type PatchedMeta,
  defaultVersionResolver,
  options,
  readCurrentPatchedMeta,
  resolveSourceClaudePath,
  resolveStrategy,
} from "@mcp-cli/core";
import { type SelfSignedMaterial, ensureSelfSignedCert } from "../tls/self-signed";

export interface ResolvedClaude {
  /** Path to the binary mcpd should pass to spawn(). */
  binaryPath: string;
  /** TLS material for the WSS listener; null when running in legacy ws:// mode. */
  tlsConfig: { cert: string; key: string } | null;
  /** Strategy id from the patcher registry (e.g. `noop-pre-2.1.120`). */
  strategyId: string;
  /** Resolved claude version. */
  version: string;
  /** Path to the source claude binary on PATH (always the user's binary, never the patched copy). */
  sourcePath: string;
}

export interface UnresolvedClaude {
  /** Human-readable, actionable error. Surfaced verbatim to spawn callers. */
  error: string;
  /** Coarse classification for logs / metrics. */
  reason:
    | "no-claude"
    | "version-probe-failed"
    | "unsupported-version"
    | "patch-missing"
    | "patch-stale"
    | "patched-binary-missing";
  /** Version, when known. Null when claude couldn't even be invoked. */
  version: string | null;
}

export type ClaudeResolution = ResolvedClaude | UnresolvedClaude;

export interface ResolverDeps {
  /** Default: `which claude`. Override for tests. */
  resolveSourcePath?: () => string | null;
  /** Default: spawn `<bin> --version`. Override for tests. */
  versionResolver?: (binPath: string) => Promise<string>;
  /** Default: read `~/.mcp-cli/claude-patched/current` metadata. */
  readPatchedMeta?: () => PatchedMeta | null;
  /** Override the claude-patched store dir (used to derive patched-binary paths). */
  patchedStoreDir?: string;
  /** Default: generate or load the cached cert under `~/.mcp-cli/tls/`. */
  ensureCert?: () => SelfSignedMaterial;
}

export function isResolved(r: ClaudeResolution): r is ResolvedClaude {
  return (r as ResolvedClaude).binaryPath !== undefined;
}

/**
 * Idempotent: every call re-probes claude --version so callers can detect
 * post-startup auto-updates if they want. The daemon currently calls this
 * once at worker startup; lazy / per-spawn callers can opt into the cost.
 */
export async function resolveClaudeForSpawn(deps: ResolverDeps = {}): Promise<ClaudeResolution> {
  const sourcePath = (deps.resolveSourcePath ?? resolveSourceClaudePath)();
  if (!sourcePath) {
    return {
      error: "claude binary not found on PATH. Install Claude Code: https://claude.com/claude-code",
      reason: "no-claude",
      version: null,
    };
  }

  let version: string;
  try {
    version = await (deps.versionResolver ?? defaultVersionResolver)(sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Could not determine claude version: ${msg}`,
      reason: "version-probe-failed",
      version: null,
    };
  }

  const strategy = resolveStrategy(version);
  if (!strategy) {
    return {
      error: `claude ${version} is not supported by any registered patch strategy. Upgrade mcx (which ships a strategy registry that's tested against new claude releases), or file an issue at https://github.com/theshadow27/mcp-cli/issues with the version.`,
      reason: "unsupported-version",
      version,
    };
  }

  // noop strategy: no patching needed. Spawn via PATH lookup (legacy
  // behavior) so symlink/wrapper rewrites between resolver and spawn keep
  // working — `which` is consulted only to detect *whether* claude exists,
  // never to pin the resolved path.
  if (strategy.id.startsWith("noop")) {
    return {
      binaryPath: "claude",
      tlsConfig: null,
      strategyId: strategy.id,
      version,
      sourcePath,
    };
  }

  // Patching needed. Look up the cached patched copy.
  const meta = (deps.readPatchedMeta ?? readCurrentPatchedMeta)();
  if (!meta) {
    return {
      error: `claude ${version} requires a patched copy (#1808). Run \`mcx claude patch-update\` to create it.`,
      reason: "patch-missing",
      version,
    };
  }
  if (meta.version !== version) {
    return {
      error: `claude ${version} differs from the patched copy (${meta.version}). claude was likely auto-updated. Run \`mcx claude patch-update\` to refresh the patched copy.`,
      reason: "patch-stale",
      version,
    };
  }

  // Derive the patched binary path. The store layout is `<storeDir>/<version>.patched`.
  const storeDir = deps.patchedStoreDir ?? options.CLAUDE_PATCHED_DIR;
  const patchedPath = join(storeDir, `${meta.version}.patched`);
  if (!existsSync(patchedPath)) {
    return {
      error: `Patched binary missing at ${patchedPath} (metadata exists, file does not). Run \`mcx claude patch-update --force\`.`,
      reason: "patched-binary-missing",
      version,
    };
  }

  // Patched flow: load (or generate) the loopback cert.
  const cert = (deps.ensureCert ?? ensureSelfSignedCert)();

  return {
    binaryPath: patchedPath,
    tlsConfig: { cert: cert.cert, key: cert.key },
    strategyId: meta.strategyId,
    version,
    sourcePath,
  };
}
