/**
 * Resilient MCP tool caller — wraps McpToolCaller with retry, rate-limit handling,
 * tool name discovery, and classified error reporting.
 *
 * Handles the reality that:
 * - Atlassian APIs return 429 and need exponential backoff
 * - The Atlassian MCP server renames tools across versions
 * - Raw MCP errors are opaque and need classification for users
 */
import type { McpToolCaller } from "./provider";

// ── Error classification ─────────────────────────────────────

export type VfsErrorKind = "auth" | "rate_limit" | "network" | "not_found" | "conflict" | "api";

export class VfsError extends Error {
  constructor(
    public readonly kind: VfsErrorKind,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "VfsError";
  }
}

/** Classify a raw error message into a VfsErrorKind. */
export function classifyError(message: string): VfsErrorKind {
  const lower = message.toLowerCase();

  // Auth errors
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication") ||
    lower.includes("not authenticated") ||
    lower.includes("invalid token") ||
    lower.includes("token expired")
  ) {
    return "auth";
  }

  // Rate limiting
  if (lower.includes("429") || lower.includes("too many requests") || lower.includes("rate limit")) {
    return "rate_limit";
  }

  // Network errors
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("dns")
  ) {
    return "network";
  }

  // Not found
  if (lower.includes("404") || lower.includes("not found") || lower.includes("unknown tool")) {
    return "not_found";
  }

  // Version conflict
  if (lower.includes("409") || lower.includes("conflict") || lower.includes("version")) {
    return "conflict";
  }

  return "api";
}

/** Convert a VfsError into a user-friendly message. */
export function friendlyMessage(err: VfsError, context?: string): string {
  const ctx = context ? ` (${context})` : "";
  switch (err.kind) {
    case "auth":
      return `Authentication failed${ctx}. Check your Atlassian credentials:\n  mcx auth atlassian`;
    case "rate_limit":
      return `Rate limited by the remote API${ctx}. Retries exhausted — try again in a few minutes.`;
    case "network":
      return `Network error${ctx}. Check your connection and that the MCP server is running:\n  mcx status`;
    case "not_found":
      return `Resource not found${ctx}. The page or tool may have been removed.`;
    case "conflict":
      return `Version conflict${ctx}. Someone else edited this page — pull first:\n  mcx vfs pull`;
    case "api":
      return `API error${ctx}: ${err.message}`;
  }
}

// ── Tool name aliases ────────────────────────────────────────

/**
 * Known tool name variants for the Atlassian MCP server.
 * The Atlassian MCP has renamed tools 3x in 6 months.
 * Map from canonical name → list of known aliases (tried in order).
 */
const ATLASSIAN_TOOL_ALIASES: Record<string, string[]> = {
  getAccessibleAtlassianResources: [
    "getAccessibleAtlassianResources",
    "get_accessible_atlassian_resources",
    "atlassian_get_accessible_resources",
  ],
  getConfluenceSpaces: [
    "getConfluenceSpaces",
    "get_confluence_spaces",
    "confluence_get_spaces",
    "confluence_search_spaces",
  ],
  getPagesInConfluenceSpace: [
    "getPagesInConfluenceSpace",
    "get_pages_in_confluence_space",
    "confluence_get_pages",
    "confluence_list_pages",
  ],
  searchConfluenceUsingCql: [
    "searchConfluenceUsingCql",
    "search_confluence_using_cql",
    "confluence_search",
    "confluence_search_cql",
  ],
  getConfluencePage: ["getConfluencePage", "get_confluence_page", "confluence_get_page", "confluence_get_page_by_id"],
  updateConfluencePage: ["updateConfluencePage", "update_confluence_page", "confluence_update_page"],
  createConfluencePage: ["createConfluencePage", "create_confluence_page", "confluence_create_page"],
  deleteConfluencePage: ["deleteConfluencePage", "delete_confluence_page", "confluence_delete_page"],
};

// ── Retry logic ──────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 4). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms (default: 30000). */
  maxDelayMs?: number;
  /** Progress callback for backoff waits. */
  onRetry?: (attempt: number, delayMs: number, error: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number, baseMs: number, maxMs: number): number {
  // Exponential backoff with jitter: base * 2^attempt + random(0, base)
  const exponential = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, maxMs);
}

// ── Resilient caller ─────────────────────────────────────────

export interface ResilientCallerOptions extends RetryOptions {
  /** The underlying MCP tool caller. */
  callTool: McpToolCaller;
  /** Enable tool name discovery via aliases (default: true). */
  toolDiscovery?: boolean;
}

/**
 * Create a resilient MCP tool caller that wraps the base caller with:
 * - Exponential backoff retry on rate-limit (429) errors
 * - Tool name discovery: if a tool call fails with "not found"/"unknown tool",
 *   try known aliases before giving up
 * - Error classification into VfsError types
 */
export function createResilientCaller(opts: ResilientCallerOptions): McpToolCaller {
  const { callTool, maxRetries = 4, baseDelayMs = 1000, maxDelayMs = 30_000, onRetry, toolDiscovery = true } = opts;

  // Cache of resolved tool names: canonical → actual working name
  const resolvedToolNames = new Map<string, string>();

  async function callWithRetry(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await callTool(server, tool, args, timeoutMs);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const kind = classifyError(lastError.message);

        if (kind === "rate_limit" && attempt < maxRetries) {
          const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs);
          onRetry?.(attempt + 1, delay, lastError.message);
          await sleep(delay);
          continue;
        }

        // Non-retryable error — break out
        break;
      }
    }

    // Classify and throw
    const message = lastError?.message ?? "Unknown error";
    throw new VfsError(classifyError(message), message, lastError);
  }

  async function callWithDiscovery(
    server: string,
    canonicalTool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    // If we've already resolved this tool name, use the cached version
    const cached = resolvedToolNames.get(canonicalTool);
    if (cached) {
      return callWithRetry(server, cached, args, timeoutMs);
    }

    // Try the canonical name first
    try {
      const result = await callWithRetry(server, canonicalTool, args, timeoutMs);
      resolvedToolNames.set(canonicalTool, canonicalTool);
      return result;
    } catch (err) {
      if (!(err instanceof VfsError) || err.kind !== "not_found") {
        throw err;
      }

      // Tool not found — try aliases
      const aliases = ATLASSIAN_TOOL_ALIASES[canonicalTool];
      if (!aliases || aliases.length <= 1) {
        throw err; // No aliases to try
      }

      for (const alias of aliases.slice(1)) {
        // Skip the canonical name (already tried)
        try {
          const result = await callWithRetry(server, alias, args, timeoutMs);
          resolvedToolNames.set(canonicalTool, alias);
          return result;
        } catch (aliasErr) {
          if (aliasErr instanceof VfsError && aliasErr.kind === "not_found") {
            continue; // Try next alias
          }
          throw aliasErr; // Different error — propagate
        }
      }

      // All aliases failed
      const triedNames = aliases.join(", ");
      throw new VfsError(
        "not_found",
        `Tool "${canonicalTool}" not found. Tried aliases: ${triedNames}. Your Atlassian MCP server may use different tool names — check "mcx ls atlassian".`,
        err.cause,
      );
    }
  }

  if (toolDiscovery) {
    return callWithDiscovery;
  }
  return callWithRetry;
}
