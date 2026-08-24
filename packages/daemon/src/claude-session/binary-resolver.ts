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
 * Resolution runs at worker startup, and again before any spawn taken while
 * the previous outcome was `error` — `mcx claude patch-update` writes the
 * patched store from a *different* process, so a resolution cached for the
 * daemon's lifetime made the error's own remediation instruction impossible to
 * act on without `mcx daemon restart` (#3013). The worker still starts even on
 * error: the daemon needs to keep handling read-only operations (list / log /
 * wait) for any sessions already in flight.
 *
 * That second, post-startup call runs on the thread already serving those
 * sessions, which constrains it in two ways (#3289 review):
 *
 *   - **It must not block.** Every subprocess this module drives is awaited,
 *     never `spawnSync`'d, so a slow `claude --version` parks one promise
 *     instead of freezing the worker's event loop. Callers on the serving
 *     thread additionally pass `mode: "spawn-only"` to skip cert work, which
 *     is the other (and larger) synchronous cost.
 *   - **It cannot rebind the listener.** `Bun.serve` fixes its TLS mode at bind
 *     time, so a resolution taken later can disagree with the listener that is
 *     already up. `listenerTls` states the requirement explicitly for exactly
 *     that comparison — see `ClaudeWsServer.applySpawnResolution`, which fails
 *     closed rather than spawn a binary the live listener cannot serve.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type PatchStrategy,
  type PatchedMeta,
  defaultVersionResolver,
  options,
  readCurrentPatchedMeta,
  resolveSourceClaudePathAsync,
  resolveStrategy,
} from "@mcp-cli/core";
import { type SelfSignedMaterial, ensureSelfSignedCert } from "../tls/self-signed";

/**
 * Scheme the WS listener has to be bound for, so claude's `--sdk-url` points at
 * an endpoint it will actually connect to.
 *
 * A patched claude (2.1.120+) enforces a host allowlist that only accepts
 * `wss://[::1]`; an unpatched one has no TLS story at all. Handing either the
 * other one's URL is a *silent* connect failure, so this is the invariant the
 * daemon must never violate — and, since `Bun.serve`'s TLS mode is fixed at
 * bind time, the one thing a live daemon cannot fix by itself (#3013).
 */
export type ListenerTls = "wss" | "plain-ws";

/** `ListenerTls`, plus the honest "we never got far enough to know" case. */
export type ListenerTlsRequirement = ListenerTls | "unknown";

export interface ResolvedClaude {
  /** Path to the binary mcpd should pass to spawn(). */
  binaryPath: string;
  /**
   * TLS material for the WSS listener; null when running in legacy ws:// mode.
   * Also null under `mode: "spawn-only"`, where no material is loaded at all —
   * read `listenerTls` for what the binary actually needs.
   */
  tlsConfig: { cert: string; key: string } | null;
  /** Scheme this binary requires of the listener. */
  listenerTls: ListenerTls;
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
  /**
   * TLS material for the WS listener, non-null when the *version* requires the
   * patched (wss://) transport even though the patched copy itself is missing
   * or stale. The listener's TLS mode is a property of the claude version, not
   * of whether a fresh patched copy happens to exist on disk — keeping those
   * two apart is what lets a later `mcx claude patch-update` be picked up by
   * swapping the binary path alone, with no daemon restart (#3013).
   *
   * Null for the pre-patch failures (no claude, probe failed, unsupported),
   * where nothing is known about which transport the binary would need — and
   * null on every branch under `mode: "spawn-only"`, which loads no material.
   */
  tlsConfig: { cert: string; key: string } | null;
  /**
   * Scheme the listener would need for this claude — `"unknown"` on the
   * pre-patch failures, where the version could not be established (or is not
   * one any strategy knows), so nothing can be said about the transport.
   *
   * Distinct from `tlsConfig === null`, which also covers "material could not
   * be loaded" and "material was not requested". A caller deciding whether a
   * *live* listener still matches a refreshed resolution must read this, never
   * the material (#3289 review).
   */
  listenerTls: ListenerTlsRequirement;
}

export type ClaudeResolution = ResolvedClaude | UnresolvedClaude;

export interface ResolverDeps {
  /** Default: `which claude` (async, off the event loop). Override for tests. */
  resolveSourcePath?: () => string | null | Promise<string | null>;
  /** Default: spawn `<bin> --version`. Override for tests. */
  versionResolver?: (binPath: string) => Promise<string>;
  /** Default: read `~/.mcp-cli/claude-patched/current` metadata. */
  readPatchedMeta?: () => PatchedMeta | null;
  /** Override the claude-patched store dir (used to derive patched-binary paths). */
  patchedStoreDir?: string;
  /** Default: generate or load the cached cert under `~/.mcp-cli/tls/`. */
  ensureCert?: () => SelfSignedMaterial;
  /** Default: BUILTIN_STRATEGIES. Override for tests. */
  strategies?: readonly PatchStrategy[];
  /**
   * What the caller intends to do with the result.
   *
   * - `"listener"` (default) — the caller is about to bind a listener, so TLS
   *   material is loaded and a failure to load it is loud on the resolved path.
   * - `"spawn-only"` — the caller only wants to know *which binary to spawn*
   *   and *what the listener would have to be*, and cannot rebind anything.
   *   No TLS material is loaded: `tlsConfig` is null on every branch and
   *   `listenerTls` carries the requirement instead.
   *
   * `"spawn-only"` exists for the post-startup refresh, which runs on the
   * thread already serving live sessions. `ensureSelfSignedCert` shells out to
   * openssl up to four times (three 5s probes plus a 30s keygen) — synchronous
   * work that would stall every co-hosted session for as long as it ran
   * (#3289 review). A `"spawn-only"` result must never be used to construct a
   * listener; the material it would need is deliberately absent.
   */
  mode?: "listener" | "spawn-only";
  /**
   * Called when TLS material was wanted but could not be loaded on a branch
   * that degrades instead of throwing. Without it a permanently broken openssl
   * (or cert dir) silently pins the daemon to plain ws forever (#3289 review).
   * Default: no-op — the worker passes a logger, because a worker thread's
   * bare console output bypasses the daemon's logger.
   */
  onCertError?: (err: unknown) => void;
}

export function isResolved(r: ClaudeResolution): r is ResolvedClaude {
  return (r as ResolvedClaude).binaryPath !== undefined;
}

/**
 * TLS material for the *error* branches, where the listener still has to come
 * up in wss:// mode so a later refresh can enable spawning in place (#3013).
 *
 * Best-effort by design: on the resolved path a cert failure must be loud (a
 * plain-ws listener would hand the patched binary a URL its allowlist rejects),
 * but here spawning is already refused with an actionable message — degrading
 * to plain ws is strictly better than turning that message into a worker-startup
 * crash that also kills list/log/wait.
 */
function bestEffortTls(
  ensureCert: () => SelfSignedMaterial,
  onCertError: (err: unknown) => void,
): { cert: string; key: string } | null {
  try {
    return loadTls(ensureCert);
  } catch (err) {
    onCertError(err);
    return null;
  }
}

/** TLS material for the resolved path, where a cert failure must stay loud. */
function loadTls(ensureCert: () => SelfSignedMaterial): { cert: string; key: string } {
  const material = ensureCert();
  return { cert: material.cert, key: material.key };
}

/**
 * Idempotent: every call re-probes claude --version, so callers detect
 * post-startup auto-updates and patch-store changes. The worker calls this at
 * startup and again before a spawn taken while the previous outcome was an
 * error — see `refreshClaudeResolutionIfDisabled` for why the happy path does
 * not pay the probe.
 */
export async function resolveClaudeForSpawn(deps: ResolverDeps = {}): Promise<ClaudeResolution> {
  const ensureCert = deps.ensureCert ?? ensureSelfSignedCert;
  const onCertError = deps.onCertError ?? (() => {});
  const spawnOnly = deps.mode === "spawn-only";
  const sourcePath = await (deps.resolveSourcePath ?? resolveSourceClaudePathAsync)();
  if (!sourcePath) {
    return {
      error: "claude binary not found on PATH. Install Claude Code: https://claude.com/claude-code",
      reason: "no-claude",
      version: null,
      tlsConfig: null,
      listenerTls: "unknown",
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
      tlsConfig: null,
      listenerTls: "unknown",
    };
  }

  const strategy = resolveStrategy(version, deps.strategies);
  if (!strategy) {
    return {
      error: `claude ${version} is not supported by any registered patch strategy. Upgrade mcx (which ships a strategy registry that's tested against new claude releases), or file an issue at https://github.com/theshadow27/mcp-cli/issues with the version.`,
      reason: "unsupported-version",
      version,
      tlsConfig: null,
      listenerTls: "unknown",
    };
  }

  // noop strategy: no patching needed. Use the resolved sourcePath directly —
  // it already accounts for `MCX_CLAUDE_BINARY` env, the `claudeBinary` config
  // override, and `which claude` fallback. Earlier versions returned the
  // literal string "claude" here so symlink/wrapper rewrites between resolver
  // and spawn would take effect; that pattern is now subsumed by the override
  // mechanism, and the literal-"claude" form would silently bypass the user's
  // configured pin (e.g. an archived 2.1.119) when PATH points elsewhere.
  if (strategy.id.startsWith("noop")) {
    return {
      binaryPath: sourcePath,
      tlsConfig: null,
      listenerTls: "plain-ws",
      strategyId: strategy.id,
      version,
      sourcePath,
    };
  }

  // Patching needed — so from here on the listener must run wss:// regardless
  // of how the patched-copy lookup below turns out (see UnresolvedClaude.tlsConfig).
  const patchedTls = spawnOnly ? null : bestEffortTls(ensureCert, onCertError);

  // Look up the cached patched copy.
  const meta = (deps.readPatchedMeta ?? readCurrentPatchedMeta)();
  if (!meta) {
    return {
      error: `claude ${version} requires a patched copy (#1808). Run \`mcx claude patch-update\` to create it.`,
      reason: "patch-missing",
      version,
      tlsConfig: patchedTls,
      listenerTls: "wss",
    };
  }
  if (meta.version !== version) {
    return {
      error: `claude ${version} differs from the patched copy (${meta.version}). claude was likely auto-updated. Run \`mcx claude patch-update\` to refresh the patched copy.`,
      reason: "patch-stale",
      version,
      tlsConfig: patchedTls,
      listenerTls: "wss",
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
      tlsConfig: patchedTls,
      listenerTls: "wss",
    };
  }

  // Patched flow: reuse the material already loaded above (one ensureCert call
  // per resolution). Unlike the error branches this one must not be
  // best-effort — a plain-ws listener would hand the patched binary a `ws://`
  // URL its host allowlist rejects, turning a loud cert failure into a silent
  // connect failure at every spawn — so a null here re-invokes to rethrow.
  // Under `spawn-only` there is no listener to bind and nothing to be loud
  // about: `listenerTls: "wss"` still tells the caller what this binary needs.
  const tlsConfig = spawnOnly ? null : (patchedTls ?? loadTls(ensureCert));

  return {
    binaryPath: patchedPath,
    tlsConfig,
    listenerTls: "wss",
    strategyId: meta.strategyId,
    version,
    sourcePath,
  };
}
