/**
 * In-memory RemoteProvider for git-remote-mcx integration tests.
 *
 * Mirrors what the real providers (Confluence, Jira, Asana) expose but keeps
 * all state in a Map, so tests are deterministic and don't require a daemon,
 * MCP server, or network access.
 *
 * The mock is versioned: each entry has a `version` counter that increments
 * on every `push`/`create`/`delete`. Version conflicts on `push` return
 * `{ ok: false, error }` so tests can exercise non-fast-forward rejection
 * (t5801 #19).
 */

import type {
  ChangeEvent,
  FetchResult,
  PushResult,
  RemoteEntry,
  RemoteProvider,
  ResolvedScope,
  Scope,
  ValidationResult,
} from "../../providers/provider";

export interface MockEntry {
  content: string;
  version: number;
  title?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  lastModified?: string;
  /** Marks the entry as deleted; kept for `changes` replay. */
  deleted?: boolean;
}

export interface MockProviderOptions {
  /** Initial entries, keyed by id. */
  entries?: Record<string, MockEntry>;
  /** If true, the next fetch call rejects with this error. One-shot. */
  failNextFetch?: Error;
  /** If true, the next push call rejects with this error. One-shot. */
  failNextPush?: Error;
}

export interface MockProvider extends RemoteProvider {
  /** Read-only view of current provider state. */
  readonly state: Map<string, MockEntry>;
  /** Snapshot entries for assertions. */
  snapshot(): Record<string, MockEntry>;
  /** Simulate a remote-side edit — bumps version, records change. */
  remoteEdit(id: string, content: string, metadata?: Record<string, unknown>): void;
  /** Arm one-shot failure injection. */
  armFetchFailure(err: Error): void;
  armPushFailure(err: Error): void;
  /** Call counts for assertions. */
  readonly calls: { list: number; fetch: number; push: number; create: number; delete: number };
}

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const state = new Map<string, MockEntry>();
  for (const [id, e] of Object.entries(options.entries ?? {})) {
    state.set(id, { ...e });
  }

  const changeLog: ChangeEvent[] = [];
  const calls = { list: 0, fetch: 0, push: 0, create: 0, delete: 0 };
  let fetchFailure: Error | undefined = options.failNextFetch;
  let pushFailure: Error | undefined = options.failNextPush;

  function toRemoteEntry(id: string, entry: MockEntry): RemoteEntry {
    return {
      id,
      title: entry.title ?? id,
      parentId: entry.parentId,
      version: entry.version,
      lastModified: entry.lastModified ?? "2026-01-01T00:00:00Z",
      metadata: entry.metadata ?? {},
    };
  }

  const provider: MockProvider = {
    name: "mock",
    state,
    calls,

    snapshot() {
      const out: Record<string, MockEntry> = {};
      for (const [id, e] of state.entries()) out[id] = { ...e };
      return out;
    },

    remoteEdit(id, content, metadata) {
      const existing = state.get(id);
      if (!existing) throw new Error(`remoteEdit: unknown entry ${id}`);
      const updated: MockEntry = {
        ...existing,
        content,
        version: existing.version + 1,
        metadata: metadata ?? existing.metadata,
        lastModified: new Date().toISOString(),
      };
      state.set(id, updated);
      changeLog.push({ entry: toRemoteEntry(id, updated), type: "updated" });
    },

    armFetchFailure(err) {
      fetchFailure = err;
    },
    armPushFailure(err) {
      pushFailure = err;
    },

    async resolveScope(scope: Scope): Promise<ResolvedScope> {
      return { key: scope.key, cloudId: scope.cloudId ?? "mock-cloud", resolved: {} };
    },

    async *list(_scope: ResolvedScope): AsyncIterable<RemoteEntry> {
      calls.list++;
      for (const [id, entry] of state.entries()) {
        if (entry.deleted) continue;
        yield { ...toRemoteEntry(id, entry), content: entry.content };
      }
    },

    async *changes(_scope: ResolvedScope, _since: string): AsyncIterable<ChangeEvent> {
      for (const ev of changeLog) yield ev;
    },

    async fetch(_scope: ResolvedScope, id: string): Promise<FetchResult> {
      calls.fetch++;
      if (fetchFailure) {
        const err = fetchFailure;
        fetchFailure = undefined;
        throw err;
      }
      const entry = state.get(id);
      if (!entry || entry.deleted) throw new Error(`fetch: unknown entry ${id}`);
      return { content: entry.content, entry: toRemoteEntry(id, entry) };
    },

    toPath(entry: RemoteEntry): string {
      // Deterministic: use the id as the path — tests can override via title
      return `${entry.id}.md`;
    },

    frontmatter(entry: RemoteEntry): Record<string, unknown> {
      return { id: entry.id, version: entry.version, title: entry.title };
    },

    async push(
      _scope: ResolvedScope,
      id: string,
      content: string,
      baseVersion: number,
      frontmatter?: Record<string, unknown>,
    ): Promise<PushResult> {
      calls.push++;
      if (pushFailure) {
        const err = pushFailure;
        pushFailure = undefined;
        throw err;
      }
      const existing = state.get(id);
      if (!existing || existing.deleted) {
        return { ok: false, error: `unknown entry ${id}` };
      }
      if (existing.version !== baseVersion) {
        return { ok: false, error: `version conflict: base ${baseVersion}, current ${existing.version}` };
      }
      const newVersion = existing.version + 1;
      state.set(id, {
        ...existing,
        content,
        version: newVersion,
        metadata: frontmatter ?? existing.metadata,
        lastModified: new Date().toISOString(),
      });
      return { ok: true, newVersion };
    },

    validate(_content: string): ValidationResult {
      return { valid: true, errors: [], warnings: [] };
    },

    toRemote(markdown: string): string {
      return markdown;
    },

    async create(
      _scope: ResolvedScope,
      parentId: string | undefined,
      title: string,
      content: string,
    ): Promise<RemoteEntry> {
      calls.create++;
      const id = `mock-${state.size + 1}`;
      const entry: MockEntry = {
        content,
        version: 1,
        title,
        parentId,
        metadata: {},
        lastModified: new Date().toISOString(),
      };
      state.set(id, entry);
      return toRemoteEntry(id, entry);
    },

    async delete(_scope: ResolvedScope, id: string): Promise<void> {
      calls.delete++;
      const existing = state.get(id);
      if (!existing) throw new Error(`delete: unknown entry ${id}`);
      state.set(id, { ...existing, deleted: true, version: existing.version + 1 });
      changeLog.push({ entry: toRemoteEntry(id, existing), type: "deleted" });
    },
  };

  return provider;
}
