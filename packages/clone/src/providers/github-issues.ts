/**
 * GitHub Issues provider — maps a GitHub repo's issues to a local directory of markdown files.
 *
 * Layout:
 *   open/123-fix-auth-bug.md
 *   closed/100-initial-setup.md
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

/** Shape of a GitHub issue from the REST/MCP API. */
interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  assignees: Array<{ login: string }>;
  user: { login: string } | null;
  html_url: string;
  updated_at: string;
  created_at: string;
  milestone?: { title: string } | null;
  pull_request?: unknown;
}

/** Shape of a GitHub issues list response (array of issues). */
type GitHubIssuesResponse = GitHubIssue[];

/** MCP tool call result shape. */
interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Extract and parse JSON from an MCP tool call result. Throws on error responses. */
function unwrapToolResult(result: unknown): unknown {
  const mcpResult = result as McpToolResult;
  if (mcpResult?.isError) {
    const text = mcpResult.content?.[0]?.text ?? "Unknown MCP tool error";
    throw new Error(`MCP tool error: ${text}`);
  }
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

/**
 * Validate a scope key for GitHub repos. Must be `owner/repo` format.
 * Only alphanumeric, hyphens, underscores, dots, and exactly one slash allowed.
 */
function validateScopeKey(key: string): void {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(key)) {
    throw new Error(
      `Invalid scope key "${key}": must be in "owner/repo" format with only alphanumeric characters, hyphens, underscores, and dots.`,
    );
  }
}

/** Sanitize a title for use as a filename. Falls back to "issue" if title has no ASCII chars. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "issue";
}

/** Normalize labels from GitHub's mixed format (string or {name: string}). */
function normalizeLabels(labels: GitHubIssue["labels"]): string[] {
  return labels.map((l) => (typeof l === "string" ? l : l.name));
}

/** Options for creating the GitHub Issues provider. */
export interface GitHubIssuesProviderOptions {
  /** Function to call an MCP tool: (server, tool, args, timeoutMs?) → result */
  callTool: McpToolCaller;
}

/** Convert a GitHub issue to a RemoteEntry. */
function toRemoteEntry(issue: GitHubIssue): RemoteEntry {
  const parsedMs = new Date(issue.updated_at).getTime();
  const updatedMs = Number.isNaN(parsedMs) ? 0 : parsedMs;
  return {
    id: String(issue.number),
    title: issue.title,
    parentId: undefined,
    version: updatedMs,
    lastModified: issue.updated_at,
    content: issue.body ?? "",
    metadata: {
      numericId: issue.id,
      number: issue.number,
      state: issue.state,
      labels: normalizeLabels(issue.labels),
      assignees: issue.assignees.map((a) => a.login),
      author: issue.user?.login,
      url: issue.html_url,
      created: issue.created_at,
      milestone: issue.milestone?.title ?? undefined,
    },
  };
}

/** Extract and validate owner/repo from a resolved scope. */
function getOwnerRepo(scope: ResolvedScope): { owner: string; repo: string } {
  const { owner, repo } = scope.resolved as { owner: string; repo: string };
  if (!owner || !repo) {
    throw new Error(`Malformed resolved scope: missing owner or repo in scope "${scope.key}"`);
  }
  return { owner, repo };
}

export function createGitHubIssuesProvider(opts: GitHubIssuesProviderOptions): RemoteProvider {
  const { callTool } = opts;
  const SERVER = "github";

  async function callGitHub(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await callTool(SERVER, tool, args, 30_000);
    return unwrapToolResult(raw);
  }

  const provider: RemoteProvider = {
    name: "github-issues",

    async resolveScope(scope: Scope): Promise<ResolvedScope> {
      validateScopeKey(scope.key);
      const [owner, repo] = scope.key.split("/");
      return {
        key: scope.key,
        cloudId: scope.cloudId ?? "github.com",
        resolved: {
          owner,
          repo,
        },
      };
    },

    async *list(scope: ResolvedScope): AsyncIterable<RemoteEntry> {
      const { owner, repo } = getOwnerRepo(scope);
      // Fetch open and closed issues separately to get all issues
      for (const state of ["open", "closed"] as const) {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          const resp = (await callGitHub("list_issues", {
            owner,
            repo,
            state,
            per_page: 100,
            page,
            sort: "created",
            direction: "asc",
          })) as GitHubIssuesResponse;

          const issues = Array.isArray(resp) ? resp : [];
          // Filter out pull requests (GitHub API returns PRs in issues endpoint)
          for (const issue of issues) {
            if (!issue.pull_request) {
              yield toRemoteEntry(issue);
            }
          }

          hasMore = issues.length === 100;
          page++;
        }
      }
    },

    async fetch(scope: ResolvedScope, id: string): Promise<FetchResult> {
      const { owner, repo } = getOwnerRepo(scope);
      const resp = (await callGitHub("get_issue", {
        owner,
        repo,
        issue_number: Number.parseInt(id, 10),
      })) as GitHubIssue;

      const entry = toRemoteEntry(resp);
      return {
        content: entry.content ?? "",
        entry,
      };
    },

    async *changes(scope: ResolvedScope, since: string): AsyncIterable<ChangeEvent> {
      const { owner, repo } = getOwnerRepo(scope);
      const seen = new Set<number>();
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const resp = (await callGitHub("list_issues", {
          owner,
          repo,
          state: "all",
          since,
          per_page: 100,
          page,
          sort: "updated",
          direction: "desc",
        })) as GitHubIssuesResponse;

        const issues = Array.isArray(resp) ? resp : [];
        for (const issue of issues) {
          if (!issue.pull_request && !seen.has(issue.number)) {
            seen.add(issue.number);
            yield {
              entry: toRemoteEntry(issue),
              type: "updated",
            };
          }
        }

        hasMore = issues.length === 100;
        page++;
      }
    },

    toPath(entry: RemoteEntry, _entries: RemoteEntry[]): string {
      const state = (entry.metadata.state as string) ?? "open";
      const slug = slugify(entry.title);
      const number = entry.metadata.number as number;
      return `${state}/${number}-${slug}.md`;
    },

    frontmatter(entry: RemoteEntry, scope: ResolvedScope): Record<string, unknown> {
      const m = entry.metadata;
      return {
        id: m.numericId as number,
        number: m.number as number,
        title: entry.title,
        state: m.state as string,
        labels: m.labels as string[],
        assignees: m.assignees as string[],
        ...(m.author ? { author: m.author } : {}),
        ...(m.milestone ? { milestone: m.milestone } : {}),
        updated: entry.lastModified,
        url: m.url as string,
      };
    },

    async push(
      scope: ResolvedScope,
      id: string,
      content: string,
      baseVersion: number,
      frontmatter?: Record<string, unknown>,
    ) {
      const { owner, repo } = getOwnerRepo(scope);
      try {
        // Fetch current issue to check for conflicts
        const current = (await callGitHub("get_issue", {
          owner,
          repo,
          issue_number: Number.parseInt(id, 10),
        })) as GitHubIssue;

        const currentVersion = new Date(current.updated_at).getTime();
        if (Number.isNaN(currentVersion)) {
          return {
            ok: false,
            error: `Cannot determine remote version for issue #${id}: 'updated_at' field is missing or malformed.`,
          };
        }
        if (currentVersion > baseVersion) {
          return {
            ok: false,
            error: `Version conflict: issue #${id} was updated remotely (${current.updated_at}). Pull first to get the latest version.`,
          };
        }

        // Build update payload
        const updateArgs: Record<string, unknown> = {
          owner,
          repo,
          issue_number: Number.parseInt(id, 10),
          body: content,
        };
        if (frontmatter?.title && frontmatter.title !== current.title) {
          updateArgs.title = frontmatter.title;
        }
        if (frontmatter?.state && frontmatter.state !== current.state) {
          updateArgs.state = frontmatter.state;
        }
        if (frontmatter?.labels) {
          updateArgs.labels = frontmatter.labels;
        }

        const updated = (await callGitHub("update_issue", updateArgs)) as GitHubIssue;

        return {
          ok: true,
          newVersion: new Date(updated.updated_at).getTime(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },

    async create(scope: ResolvedScope, _parentId: string | undefined, title: string, content: string) {
      const { owner, repo } = getOwnerRepo(scope);
      const resp = (await callGitHub("create_issue", {
        owner,
        repo,
        title,
        body: content,
      })) as GitHubIssue;

      return toRemoteEntry(resp);
    },
  };

  return provider;
}
