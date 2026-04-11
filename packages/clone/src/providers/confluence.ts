/**
 * Confluence provider — maps a Confluence space to a local directory of markdown files.
 */
import type {
  ChangeEvent,
  FetchResult,
  McpToolCaller,
  RemoteEntry,
  RemoteProvider,
  ResolvedScope,
  Scope,
} from "./provider";

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

/** MCP tool call result shape. */
interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Extract and parse JSON from an MCP tool call result. */
function unwrapToolResult(result: unknown): unknown {
  const mcpResult = result as McpToolResult;
  if (mcpResult?.content?.[0]?.type === "text") {
    const text = mcpResult.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

/** Options for creating the Confluence provider. */
export interface ConfluenceProviderOptions {
  /** Function to call an MCP tool: (server, tool, args, timeoutMs?) → result */
  callTool: McpToolCaller;
  /** Concurrency for individual page fetches when needed (default: 5). */
  fetchConcurrency?: number;
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

export function createConfluenceProvider(opts: ConfluenceProviderOptions): RemoteProvider {
  const { callTool } = opts;
  const SERVER = "atlassian";

  async function callAtlassian(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await callTool(SERVER, tool, args, 30_000);
    return unwrapToolResult(raw);
  }

  const provider: RemoteProvider = {
    name: "confluence",

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
      let cursor: string | undefined;
      let total = 0;

      do {
        const args: Record<string, unknown> = {
          cloudId: scope.cloudId,
          spaceId,
          contentFormat: "markdown",
          limit: 250,
          sort: "id",
          status: "current",
        };
        if (cursor) args.cursor = cursor;

        const resp = (await callAtlassian("getPagesInConfluenceSpace", args)) as PagesResponse;

        for (const page of resp.results) {
          total++;
          yield toRemoteEntry(page, true);
        }

        // Extract cursor from next link
        cursor = undefined;
        if (resp._links?.next) {
          const match = resp._links.next.match(/cursor=([^&]+)/);
          if (match) cursor = decodeURIComponent(match[1]);
        }
      } while (cursor);
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
        const message = err instanceof Error ? err.message : String(err);
        // Confluence returns 409 on version mismatch
        const isConflict = message.includes("409") || message.includes("conflict") || message.includes("version");
        if (isConflict) {
          return {
            ok: false,
            error: `Version conflict: local base is v${baseVersion}. Pull first to get the latest version.`,
          };
        }
        return { ok: false, error: message };
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

  const entries: RemoteEntry[] = [];
  const contentMap = new Map<string, string>();
  let cursor: string | undefined;
  let total = 0;

  do {
    const args: Record<string, unknown> = {
      cloudId: scope.cloudId,
      spaceId,
      contentFormat: "markdown",
      limit: 250,
      sort: "id",
      status: "current",
    };
    if (cursor) args.cursor = cursor;

    const raw = await callTool("atlassian", "getPagesInConfluenceSpace", args, 60_000);
    const resp = unwrapToolResult(raw) as PagesResponse;

    for (const page of resp.results) {
      total++;
      const entry = toRemoteEntry(page);
      entries.push(entry);
      contentMap.set(page.id, page.body ?? "");
      onProgress?.(total, page);
    }

    cursor = undefined;
    if (resp._links?.next) {
      const match = resp._links.next.match(/cursor=([^&]+)/);
      if (match) cursor = decodeURIComponent(match[1]);
    }
  } while (cursor);

  return { entries, contentMap };
}
