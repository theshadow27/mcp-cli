/**
 * Factory for ctx.state / ctx.globalState accessors.
 *
 * Talks to the daemon via IPC so state is shared across every process that
 * runs aliases (subprocess executor, CLI direct, alias MCP server).
 */

import type { AliasStateAccessor } from "./alias";
import { resolveRealpath } from "./fs";
import { findGitRoot } from "./git";
import { ipcCall } from "./ipc-client";

/** Namespace used by ctx.globalState. */
export const GLOBAL_STATE_NAMESPACE = "__global__";

/** Sentinel repo_root used when the caller is not inside a git repository. */
export const NO_REPO_ROOT = "__none__";

/**
 * The `repo_root` half of an `alias_state` key — the counterpart to
 * {@link workItemStateNamespace}, which owns the `namespace` half.
 *
 * **Every reader and writer of phase state must call this.** The derivation used to be
 * open-coded at six call sites that did not agree (#3209): the phase runner used
 * `findGitRoot(cwd) ?? NO_REPO_ROOT`, the auto-persist and spawn paths in the same file
 * used `findGitRoot(cwd) ?? cwd`, `mcx track` / `mcx tracked` passed the **raw cwd** with
 * no git-root call at all, and the daemon's automation dispatcher realpathed its own cwd.
 * Two of those diverge with no domains involved: `mcx track <n> --meta k=v` run from a
 * subdirectory (or a linked worktree) wrote under that subdirectory while the phase runner
 * read under the repo root, and outside a git repo `ctx.state` used `NO_REPO_ROOT` while
 * `phase_state_set` used the raw cwd. Neither errors. Both return `{}`, which a caller
 * cannot distinguish from "no state" — a silent split store, not a failure anyone sees.
 *
 * `cwd` is **required and may be undefined on purpose**: `undefined` means "no caller cwd
 * is known" and yields `NO_REPO_ROOT`, never `process.cwd()`. Defaulting to the current
 * directory would silently key a daemon-side caller to the *daemon's* cwd (see PR #1307
 * review); a caller that genuinely means "here" passes `process.cwd()` itself.
 *
 * `findRoot` exists only so callers that already inject a git-root stub for tests keep
 * their seam. Production callers pass nothing.
 */
export function workItemStateRoot(
  cwd: string | undefined,
  findRoot: (cwd: string) => string | null = findGitRoot,
): string {
  if (!cwd) return NO_REPO_ROOT;
  const root = findRoot(cwd);
  // Realpath so a symlinked checkout keys identically however it was reached. The daemon
  // realpaths every repoRoot it receives, so this only aligns what the *client* believes
  // its root is (`ctx.repoRoot`, the `gh` client cwd) with the row it will actually hit.
  return root === null ? NO_REPO_ROOT : resolveRealpath(root);
}

/**
 * Per-alias namespaces are prefixed so they can never collide with the
 * reserved `__global__` sentinel — an alias literally named `__global__`
 * would otherwise share a bucket with everyone's `ctx.globalState`.
 */
export function aliasUserNamespace(aliasName: string): string {
  return `alias:${aliasName}`;
}

export interface AliasStateOptions {
  repoRoot: string;
  namespace: string;
  /**
   * Optional override for the IPC transport — used by tests.
   * When omitted, talks to the daemon via the Unix-socket ipcCall.
   */
  call?: typeof ipcCall;
}

/**
 * In-memory accessor scoped to this accessor instance / process lifetime.
 * Values are JSON-cloned on write to match daemon-backed serialization
 * semantics. Used when no work item is bound so state never leaks between
 * unrelated runs via shared daemon-backed storage.
 */
export function createEphemeralState(): AliasStateAccessor {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = store.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw as string) as T);
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async all(): Promise<Record<string, unknown>> {
      const entries: Record<string, unknown> = {};
      for (const [k, v] of store) {
        entries[k] = JSON.parse(v as string);
      }
      return entries;
    },
  };
}

/**
 * Build an accessor bound to a specific (repoRoot, namespace) scope.
 *
 * The accessor serialises values with JSON.stringify on set and JSON.parse on
 * read, so anything JSON-serialisable round-trips cleanly. Structured-schema
 * validation is a no-op today; the manifest (#1286) will wire in a validator.
 */
export function createAliasState(opts: AliasStateOptions): AliasStateAccessor {
  const call = opts.call ?? ipcCall;
  const { repoRoot, namespace } = opts;
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const { value } = await call("aliasStateGet", { repoRoot, namespace, key });
      return value as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await call("aliasStateSet", { repoRoot, namespace, key, value });
    },
    async delete(key: string): Promise<void> {
      await call("aliasStateDelete", { repoRoot, namespace, key });
    },
    async all(): Promise<Record<string, unknown>> {
      const { entries } = await call("aliasStateAll", { repoRoot, namespace });
      return entries;
    },
  };
}
