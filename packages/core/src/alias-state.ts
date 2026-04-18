/**
 * Factory for ctx.state / ctx.globalState accessors.
 *
 * Talks to the daemon via IPC so state is shared across every process that
 * runs aliases (subprocess executor, CLI direct, alias MCP server).
 */

import type { AliasStateAccessor } from "./alias";
import { ipcCall } from "./ipc-client";

/** Namespace used by ctx.globalState. */
export const GLOBAL_STATE_NAMESPACE = "__global__";

/** Sentinel repo_root used when the caller is not inside a git repository. */
export const NO_REPO_ROOT = "__none__";

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
 * Build an accessor bound to a specific (repoRoot, namespace) scope.
 *
 * The accessor serialises values with JSON.stringify on set and JSON.parse on
 * read, so anything JSON-serialisable round-trips cleanly. Structured-schema
 * validation is a no-op today; the manifest (#1286) will wire in a validator.
 */
/**
 * No-op accessor that discards writes and returns empty reads.
 * Used when no work item is bound so state never leaks between unrelated runs.
 */
export function createEphemeralState(): AliasStateAccessor {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async all(): Promise<Record<string, unknown>> {
      return Object.fromEntries(store);
    },
  };
}

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
