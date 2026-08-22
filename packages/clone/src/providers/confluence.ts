/**
 * Confluence provider — maps a Confluence space to a local directory of markdown files.
 */
import { unwrapToolResultJson } from "@mcp-cli/core";
import { AdaptiveBatchSizer } from "./adaptive-batch";
import type {
  ChangeEvent,
  FetchResult,
  McpToolCaller,
  RemoteEntry,
  RemoteProvider,
  ResolvedScope,
  Scope,
} from "./provider";
import {
  RETRY_DEFAULTS,
  type RetryOptions,
  VfsError as VfsErrorClass,
  classifyError,
  computeBackoff,
  createResilientCaller,
  friendlyMessage,
  sleep,
} from "./resilient-caller";

/** Default page size for paginated Confluence listings. */
export const DEFAULT_BATCH_SIZE = 250;

/** Thrown when CQL search returns truncated results, signaling the caller to fall back to full sync. */
export class TruncatedChangesError extends Error {
  constructor(
    public totalSize: number,
    public returnedSize: number,
  ) {
    super(
      `Incremental sync truncated: ${totalSize} changes but only ${returnedSize} returned. Falling back to full sync.`,
    );
    this.name = "TruncatedChangesError";
  }
}

/** Shape of a page from the Confluence v2 API. */
interface ConfluencePage {
  id: string;
  title: string;
  status: string;
  spaceId: string;
  parentId?: string;
  parentType?: string;
  authorId?: string;
  ownerId?: string;
  createdAt: string;
  version: {
    number: number;
    message?: string;
    createdAt: string;
    authorId?: string;
  };
  body?: string;
}

/** Shape of the paginated pages response. */
interface PagesResponse {
  results: ConfluencePage[];
  _links?: {
    next?: string;
    base?: string;
  };
}

/** Shape of the spaces response. */
interface SpacesResponse {
  results: Array<{
    id: string;
    key: string;
    name: string;
    type: string;
    status: string;
    homepageId?: string;
    _links?: { webui?: string };
  }>;
  _links?: { base?: string };
}

/** Shape of accessible resources response. */
interface ResourcesResponse {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
}

// McpToolCaller is now defined in provider.ts and re-exported here for backwards compatibility.
export type { McpToolCaller } from "./provider";

/** Options for creating the Confluence provider. */
export interface ConfluenceProviderOptions {
  /** Function to call an MCP tool: (server, tool, args, timeoutMs?) → result */
  callTool: McpToolCaller;
  /** Concurrency for individual page fetches when needed (default: 5). */
  fetchConcurrency?: number;
  /** Retry/backoff options for rate limiting. */
  retry?: RetryOptions;
  /** Disable tool name discovery/fallback (default: false). */
  disableToolDiscovery?: boolean;
  /**
   * Upper bound on items per page request (default: 250). Batches shrink below
   * this on rate limiting and grow back toward it on fast successes.
   */
  batchSize?: number;
}

/** Validate a scope key to prevent CQL injection. Only alphanumeric, hyphens, and underscores allowed. */
function validateScopeKey(key: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(`Invalid scope key "${key}": must contain only alphanumeric characters, hyphens, and underscores.`);
  }
}

function toRemoteEntry(page: ConfluencePage, includeContent = false): RemoteEntry {
  return {
    id: page.id,
    title: page.title,
    parentId: page.parentId,
    version: page.version.number,
    lastModified: page.version.createdAt,
    ...(includeContent && page.body != null ? { content: page.body } : {}),
    metadata: {
      spaceId: page.spaceId,
      status: page.status,
      authorId: page.authorId,
      createdAt: page.createdAt,
    },
  };
}

/** Sanitize a title for use as a filename. */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, "_") // filesystem-unsafe chars
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

/** Extract the opaque pagination cursor from a response's next link. */
function nextCursor(resp: PagesResponse): string | undefined {
  if (!resp._links?.next) return undefined;
  const match = resp._links.next.match(/cursor=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Fetch one page of results at the sizer's current batch size.
 *
 * This loop owns the entire rate-limit response for paginated reads: on a 429 it
 * shrinks the sizer, sleeps the exponential backoff, then re-issues the request
 * at the *new, smaller* limit. That ordering is the whole point — a retry that
 * replays the identical `limit` cannot succeed, because the 429 is a property of
 * the batch size. The caller must therefore hand in a non-retrying `call`; if an
 * inner retrier also retried the 429 it would spend this budget on identical
 * requests and reach the floor before a single smaller request went out (#2950).
 *
 * The cursor is reused across shrink-retries. Confluence v2 cursors encode a
 * position, not a span (the `limit` in `_links.next` is an echo of the request,
 * not part of the cursor), so re-requesting the same cursor with a smaller limit
 * resumes from the same item and returns a prefix of the larger window — no gap,
 * no overlap. Per Atlassian's v2 pagination contract, the client must treat the
 * cursor as opaque and may vary `limit` between requests:
 * https://developer.atlassian.com/cloud/confluence/rest/v2/intro/#pagination
 * Verified end-to-end by the round-trip corpus test in `confluence.spec.ts`
 * ("no items are skipped or duplicated when the batch shrinks mid-listing"),
 * which drives a mock that honors `limit` and asserts exact corpus equality.
 */
async function fetchPageBatch(
  call: (args: Record<string, unknown>) => Promise<PagesResponse>,
  baseArgs: Record<string, unknown>,
  cursor: string | undefined,
  sizer: AdaptiveBatchSizer,
  retry?: RetryOptions,
): Promise<PagesResponse> {
  const maxRetries = retry?.maxRetries ?? RETRY_DEFAULTS.maxRetries;
  const baseDelayMs = retry?.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = retry?.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs;

  for (let attempt = 0; ; attempt++) {
    const args: Record<string, unknown> = { ...baseArgs, limit: sizer.size };
    if (cursor) args.cursor = cursor;

    const started = Date.now();
    try {
      const resp = await call(args);
      sizer.onSuccess(Date.now() - started);
      return resp;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof VfsErrorClass ? err.kind : classifyError(message);
      if (kind !== "rate_limit" || attempt >= maxRetries) throw err;

      const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs);
      retry?.onRetry?.(attempt + 1, delay, message);
      // Shrink before sleeping so the post-backoff request is the smaller one.
      // At the floor shrink() reports false and we retry unchanged — the backoff
      // is still worth spending, since the floor may simply be over quota.
      sizer.shrink();
      await sleep(delay, retry?.signal);
    }
  }
}

export function createConfluenceProvider(opts: ConfluenceProviderOptions): RemoteProvider {
  const SERVER = "atlassian";

  // Sizer state is owned by the pagination loop alone: only `fetchPageBatch`
  // shrinks and grows it. Letting unrelated calls (single-page fetch, CQL search,
  // create/update) shrink it would pin the listing batch near the floor with no
  // path back, since none of them ever reports a success.
  const sizer = new AdaptiveBatchSizer({ max: opts.batchSize ?? DEFAULT_BATCH_SIZE });

  // Wrap the base caller with retry + tool discovery for every non-paginated call.
  const resilientCallTool = createResilientCaller({
    callTool: opts.callTool,
    toolDiscovery: !opts.disableToolDiscovery,
    ...opts.retry,
  });

  // Paginated reads get tool discovery but *no* inner retry: `fetchPageBatch`
  // owns the 429 loop so that each retry goes out at a smaller limit.
  const pagingCallTool = createResilientCaller({
    callTool: opts.callTool,
    toolDiscovery: !opts.disableToolDiscovery,
    ...opts.retry,
    maxRetries: 0,
  });

  async function callAtlassian(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await resilientCallTool(SERVER, tool, args, 30_000);
    return unwrapToolResultJson<unknown>(raw);
  }

  async function callAtlassianPaged(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await pagingCallTool(SERVER, tool, args, 30_000);
    return unwrapToolResultJson<unknown>(raw);
  }

  const provider: RemoteProvider = {
    name: "confluence",
    itemNoun: "pages",

    async resolveScope(scope: Scope): Promise<ResolvedScope> {
      validateScopeKey(scope.key);
      let cloudId = scope.cloudId;

      // Auto-discover cloudId if not provided
      if (!cloudId) {
        const resources = (await callAtlassian("getAccessibleAtlassianResources", {})) as ResourcesResponse[];
        if (!resources || (Array.isArray(resources) && resources.length === 0)) {
          throw new Error("No accessible Atlassian resources found. Check your authentication.");
        }
        // Use first resource
        const resource = Array.isArray(resources) ? resources[0] : resources;
        cloudId = resource.id;
      }

      // Look up space by key to get spaceId
      const spacesResp = (await callAtlassian("getConfluenceSpaces", {
        cloudId,
        keys: [scope.key],
        limit: 1,
      })) as SpacesResponse;

      if (!spacesResp.results || spacesResp.results.length === 0) {
        throw new Error(`Space "${scope.key}" not found in cloud ${cloudId}`);
      }

      const space = spacesResp.results[0];
      const baseUrl = spacesResp._links?.base ?? "";

      return {
        key: scope.key,
        cloudId,
        resolved: {
          spaceId: space.id,
          spaceName: space.name,
          homepageId: space.homepageId,
          baseUrl,
        },
      };
    },

    async *list(scope: ResolvedScope): AsyncIterable<RemoteEntry> {
      const spaceId = scope.resolved.spaceId as string;
      const baseArgs = {
        cloudId: scope.cloudId,
        spaceId,
        contentFormat: "markdown",
        sort: "id",
        status: "current",
      };
      let cursor: string | undefined;

      do {
        const resp = await fetchPageBatch(
          (args) => callAtlassianPaged("getPagesInConfluenceSpace", args) as Promise<PagesResponse>,
          baseArgs,
          cursor,
          sizer,
          opts.retry,
        );

        for (const page of resp.results) {
          yield toRemoteEntry(page, true);
        }

        cursor = nextCursor(resp);
      } while (cursor);
    },

    /**
     * Page count for the space, via a CQL search asking for a single result —
     * `totalSize` is the count of matches, not of returned rows, so one cheap
     * request yields the denominator for the whole listing (#1249).
     */
    async count(scope: ResolvedScope): Promise<number | undefined> {
      // `status = current` mirrors list()'s own filter (see the listing query
      // above). Without it the two calls ask different questions and the count
      // can exceed what the listing yields — which, before the step ceiling in
      // shouldReport(), silenced progress entirely.
      const cql = `space = "${scope.key}" AND type = page AND status = current`;
      const resp = (await callAtlassian("searchConfluenceUsingCql", {
        cloudId: scope.cloudId,
        cql,
        limit: 1,
      })) as { totalSize?: number };
      return typeof resp?.totalSize === "number" ? resp.totalSize : undefined;
    },

    async fetch(scope: ResolvedScope, id: string): Promise<FetchResult> {
      const resp = (await callAtlassian("getConfluencePage", {
        cloudId: scope.cloudId,
        pageId: id,
        contentFormat: "markdown",
      })) as ConfluencePage;

      return {
        content: resp.body ?? "",
        entry: toRemoteEntry(resp),
      };
    },

    async *changes(scope: ResolvedScope, since: string): AsyncIterable<ChangeEvent> {
      // Convert ISO timestamp to CQL date format (yyyy-MM-dd HH:mm)
      const sinceDate = new Date(since);
      const cqlDate = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")} ${String(sinceDate.getHours()).padStart(2, "0")}:${String(sinceDate.getMinutes()).padStart(2, "0")}`;

      const cql = `space = "${scope.key}" AND type = page AND lastModified >= "${cqlDate}" ORDER BY lastModified DESC`;
      const resp = (await callAtlassian("searchConfluenceUsingCql", {
        cloudId: scope.cloudId,
        cql,
        limit: 250,
      })) as { results: Array<{ content: { id: string }; lastModified: string }>; totalSize: number };

      // If results were truncated, throw so the caller falls back to full sync
      // rather than silently missing pages and advancing the watermark
      if (resp.totalSize > (resp.results?.length ?? 0)) {
        throw new TruncatedChangesError(resp.totalSize, resp.results?.length ?? 0);
      }

      // Batch-fetch changed pages (CQL search doesn't return content)
      const pageIds = (resp.results ?? []).map((r) => r.content?.id).filter(Boolean) as string[];
      const BATCH_SIZE = 10;
      const fetched: Array<{ entry: RemoteEntry; content: string }> = [];

      for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
        const batch = pageIds.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (pageId) => {
            const f = await provider.fetch(scope, pageId);
            return { entry: f.entry, content: f.content };
          }),
        );
        fetched.push(...results);
      }

      for (const { entry, content } of fetched) {
        yield {
          entry: { ...entry, content },
          type: "updated",
        };
      }
    },

    toPath(entry: RemoteEntry, entries: RemoteEntry[]): string {
      // Build parent chain to construct directory path
      const entryById = new Map(entries.map((e) => [e.id, e]));
      let current: RemoteEntry | undefined = entry;

      // Walk up the parent chain
      const chain: RemoteEntry[] = [];
      const visited = new Set<string>();
      while (current) {
        if (visited.has(current.id)) break; // cycle guard
        visited.add(current.id);
        chain.unshift(current);
        current = current.parentId ? entryById.get(current.parentId) : undefined;
      }

      // Check if this entry has children (is a directory)
      const hasChildren = entries.some((e) => e.parentId === entry.id);

      // Build path from chain
      const segments: string[] = [];
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i];
        const isLast = i === chain.length - 1;
        let name = sanitizeFilename(node.title);

        // Disambiguate siblings with the same sanitized name by appending page ID
        if (isLast) {
          const siblings = entries.filter(
            (e) => e.parentId === node.parentId && e.id !== node.id && sanitizeFilename(e.title) === name,
          );
          if (siblings.length > 0) {
            name = `${name}-${node.id}`;
          }
        }

        if (isLast && !hasChildren) {
          segments.push(`${name}.md`);
        } else {
          segments.push(name);
        }
      }

      // If this entry has children, its own content goes in _index.md
      if (hasChildren) {
        segments.push("_index.md");
      }

      return segments.join("/");
    },

    frontmatter(entry: RemoteEntry, scope: ResolvedScope): Record<string, unknown> {
      const baseUrl = (scope.resolved.baseUrl as string) ?? "";
      return {
        id: entry.id,
        version: entry.version,
        space: scope.key,
        title: entry.title,
        lastModified: entry.lastModified,
        url: baseUrl ? `${baseUrl}/pages/${entry.id}` : undefined,
      };
    },

    async push(scope: ResolvedScope, id: string, content: string, baseVersion: number) {
      // Pass version.number in the update request — Confluence v2 API returns 409 on mismatch,
      // which is atomic and avoids the TOCTOU race of a separate read-then-write.
      const baseUrl = (scope.resolved.baseUrl as string) ?? "";
      const pageUrl = baseUrl ? `${baseUrl}/pages/${id}` : `page ${id}`;

      try {
        const resp = (await callAtlassian("updateConfluencePage", {
          cloudId: scope.cloudId,
          pageId: id,
          body: content,
          contentFormat: "markdown",
          versionMessage: "Updated via mcx clone",
          versionNumber: baseVersion + 1,
        })) as ConfluencePage;

        return {
          ok: true,
          newVersion: resp?.version?.number ?? baseVersion + 1,
        };
      } catch (err) {
        // Use VfsError classification if available, otherwise fall back to string matching
        if (err instanceof VfsErrorClass) {
          if (err.kind === "conflict") {
            return {
              ok: false,
              error: `Version conflict: local base is v${baseVersion}. Pull first to get the latest version.`,
            };
          }
          return { ok: false, error: `${friendlyMessage(err, pageUrl)}` };
        }
        const message = err instanceof Error ? err.message : String(err);
        const isConflict =
          message.includes("409") || message.includes("conflict") || message.includes("version mismatch");
        if (isConflict) {
          return {
            ok: false,
            error: `Version conflict: local base is v${baseVersion}. Pull first to get the latest version.`,
          };
        }
        return { ok: false, error: `Push failed for ${pageUrl}: ${message}` };
      }
    },

    async create(scope: ResolvedScope, parentId: string | undefined, title: string, content: string) {
      const spaceId = scope.resolved.spaceId as string;
      const args: Record<string, unknown> = {
        cloudId: scope.cloudId,
        spaceId,
        title,
        body: content,
        contentFormat: "markdown",
        status: "current",
      };
      if (parentId) args.parentId = parentId;

      const resp = (await callAtlassian("createConfluencePage", args)) as ConfluencePage;

      return toRemoteEntry(resp);
    },

    async delete(scope: ResolvedScope, id: string) {
      // Use deleteConfluencePage if available (Confluence REST v2: DELETE /wiki/api/v2/pages/{id}).
      // Fall back to updateConfluencePage with status="trashed" for older MCP server versions.
      try {
        await callAtlassian("deleteConfluencePage", {
          cloudId: scope.cloudId,
          pageId: id,
        });
      } catch (deleteErr) {
        const msg = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        // If the tool doesn't exist, fall back to status-based trash
        if (msg.includes("not found") || msg.includes("unknown tool") || msg.includes("Unknown tool")) {
          try {
            const currentPage = (await callAtlassian("getConfluencePage", {
              cloudId: scope.cloudId,
              pageId: id,
              contentFormat: "markdown",
            })) as ConfluencePage;

            await callAtlassian("updateConfluencePage", {
              cloudId: scope.cloudId,
              pageId: id,
              status: "trashed",
              body: currentPage.body ?? "",
              contentFormat: "markdown",
              versionMessage: "Deleted via mcx vfs",
            });
          } catch (fallbackErr) {
            throw new Error(
              `Failed to delete page ${id}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}. Delete may not be supported by your Atlassian MCP server.`,
            );
          }
        } else {
          throw new Error(`Failed to delete page ${id}: ${msg}`);
        }
      }
    },
  };

  return provider;
}

/**
 * Fetch all pages with content in bulk using getPagesInConfluenceSpace.
 * More efficient than individual fetches — gets content inline with listing.
 */
export async function bulkFetchPages(
  opts: ConfluenceProviderOptions,
  scope: ResolvedScope,
  onProgress?: (fetched: number, page: ConfluencePage) => void,
): Promise<{ entries: RemoteEntry[]; contentMap: Map<string, string> }> {
  const { callTool } = opts;
  const spaceId = scope.resolved.spaceId as string;
  const sizer = new AdaptiveBatchSizer({ max: opts.batchSize ?? DEFAULT_BATCH_SIZE });
  const baseArgs = {
    cloudId: scope.cloudId,
    spaceId,
    contentFormat: "markdown",
    sort: "id",
    status: "current",
  };

  const entries: RemoteEntry[] = [];
  const contentMap = new Map<string, string>();
  let cursor: string | undefined;
  let total = 0;

  do {
    const resp = await fetchPageBatch(
      async (args) =>
        unwrapToolResultJson<PagesResponse>(await callTool("atlassian", "getPagesInConfluenceSpace", args, 60_000)),
      baseArgs,
      cursor,
      sizer,
      opts.retry,
    );

    for (const page of resp.results) {
      total++;
      const entry = toRemoteEntry(page);
      entries.push(entry);
      contentMap.set(page.id, page.body ?? "");
      onProgress?.(total, page);
    }

    cursor = nextCursor(resp);
  } while (cursor);

  return { entries, contentMap };
}
