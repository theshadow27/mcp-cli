/**
 * RemoteProvider — abstract interface for projecting remote state into a local git repo.
 *
 * Implementations map a remote system's hierarchy (Confluence spaces, Jira projects,
 * Asana workspaces, etc.) to a local directory tree of markdown files.
 */

/** Scope identifying what to clone from a remote provider. */
export interface Scope {
  /** Provider-specific scope identifier (e.g., space key, project key). */
  key: string;
  /** Provider-specific cloud/instance identifier. Resolved automatically if omitted. */
  cloudId?: string;
}

/** A single item from the remote system. */
export interface RemoteEntry {
  /** Provider-specific unique identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Parent entry ID, if hierarchical. Undefined for root entries. */
  parentId?: string;
  /** Version number for optimistic concurrency. */
  version: number;
  /** ISO 8601 timestamp of last remote modification. */
  lastModified: string;
  /** Provider-specific metadata to round-trip through frontmatter. */
  metadata: Record<string, unknown>;
  /** Content, if available inline from listing. Avoids individual fetch. */
  content?: string;
}

/** Result of fetching a single item's content. */
export interface FetchResult {
  /** Markdown content of the item. */
  content: string;
  /** The entry metadata (may be updated since list). */
  entry: RemoteEntry;
}

/** Result of pushing local changes to the remote. */
export interface PushResult {
  /** Whether the push succeeded. */
  ok: boolean;
  /** New version number after push. */
  newVersion?: number;
  /** Error message if push failed. */
  error?: string;
}

/** A change event from the remote system. */
export interface ChangeEvent {
  /** The entry that changed. */
  entry: RemoteEntry;
  /** Type of change. */
  type: "created" | "updated" | "deleted";
}

/** Result of content validation before push. */
export interface ValidationResult {
  /** Whether the content is valid for push. */
  valid: boolean;
  /** Validation errors. */
  errors: string[];
  /** Non-fatal warnings. */
  warnings: string[];
}

/**
 * RemoteProvider interface.
 *
 * Providers are responsible for:
 * 1. Listing items in a scope (discovery)
 * 2. Fetching item content as markdown
 * 3. Mapping remote hierarchy to filesystem paths
 * 4. (Phase 2+) Pushing local changes back, creating/deleting items
 */
export interface RemoteProvider {
  /** Provider name (e.g., "confluence", "jira"). */
  readonly name: string;

  // ── Discovery ──────────────────────────────────────────────

  /** Resolve a scope key to a fully qualified scope (e.g., look up spaceId from key). */
  resolveScope(scope: Scope): Promise<ResolvedScope>;

  /** List all items in the resolved scope. Paginated via async iteration. */
  list(scope: ResolvedScope): AsyncIterable<RemoteEntry>;

  /** List items changed since a timestamp. Falls back to full list if not supported. */
  changes?(scope: ResolvedScope, since: string): AsyncIterable<ChangeEvent>;

  // ── Content ────────────────────────────────────────────────

  /** Fetch a single item's content as markdown. */
  fetch(scope: ResolvedScope, id: string): Promise<FetchResult>;

  // ── Path mapping ───────────────────────────────────────────

  /** Convert a remote entry to a relative filesystem path. */
  toPath(entry: RemoteEntry, entries: RemoteEntry[]): string;

  // ── Frontmatter ────────────────────────────────────────────

  /** Extract frontmatter fields from an entry. */
  frontmatter(entry: RemoteEntry, scope: ResolvedScope): Record<string, unknown>;

  // ── Phase 2: Write support ─────────────────────────────────

  /** Push updated content to the remote. Frontmatter fields (if provided) allow updating metadata like summary/title. */
  push?(
    scope: ResolvedScope,
    id: string,
    content: string,
    baseVersion: number,
    frontmatter?: Record<string, unknown>,
  ): Promise<PushResult>;

  /** Validate content before push. */
  validate?(content: string): ValidationResult;

  /** Convert markdown to remote storage format. */
  toRemote?(markdown: string): string;

  // ── Phase 4: Create / Delete ───────────────────────────────

  /** Create a new item in the remote. */
  create?(scope: ResolvedScope, parentId: string | undefined, title: string, content: string): Promise<RemoteEntry>;

  /** Delete an item from the remote. */
  delete?(scope: ResolvedScope, id: string): Promise<void>;
}

/** Function signature for calling MCP tools via the daemon. */
export type McpToolCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

/** Fully resolved scope with all provider-specific IDs. */
export interface ResolvedScope extends Scope {
  /** Resolved cloud/instance ID. */
  cloudId: string;
  /** Provider-specific resolved metadata (e.g., spaceId for Confluence). */
  resolved: Record<string, unknown>;
}
