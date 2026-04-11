/**
 * Jira provider — maps a Jira project's issues to a local directory of markdown files.
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

/** Shape of an issue from the Jira REST/MCP API. */
interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    issuetype?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string } | null;
    labels?: string[];
    description?: string;
    updated: string;
    created: string;
    parent?: { key: string };
  };
}

/** Shape of a Jira search response. */
interface JiraSearchResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
  total?: number;
}

/** Shape of accessible Atlassian resources response. */
interface ResourcesResponse {
  id: string;
  url: string;
  name: string;
  scopes: string[];
}

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

/** Validate a scope key to prevent JQL injection. Only alphanumeric, hyphens, and underscores allowed. */
function validateScopeKey(key: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(`Invalid scope key "${key}": must contain only alphanumeric characters, hyphens, and underscores.`);
  }
}

/** Options for creating the Jira provider. */
export interface JiraProviderOptions {
  /** Function to call an MCP tool: (server, tool, args, timeoutMs?) → result */
  callTool: McpToolCaller;
  /** Default issue type name for create (default: "Task"). */
  defaultIssueType?: string;
}

/** Convert a Jira issue to a RemoteEntry. */
function toRemoteEntry(issue: JiraIssue): RemoteEntry {
  const f = issue.fields;
  // Jira has no version number — use updated timestamp as epoch ms for ordering.
  // Guard against null/malformed dates: default to 0 so conflict detection remains functional.
  const parsedMs = new Date(f.updated).getTime();
  const updatedMs = Number.isNaN(parsedMs) ? 0 : parsedMs;
  return {
    id: issue.key,
    title: f.summary,
    parentId: f.parent?.key,
    version: updatedMs,
    lastModified: f.updated,
    content: f.description ?? "",
    metadata: {
      numericId: issue.id,
      status: f.status?.name,
      type: f.issuetype?.name,
      priority: f.priority?.name,
      assignee: f.assignee?.displayName ?? undefined,
      labels: f.labels ?? [],
      created: f.created,
      parent: f.parent?.key,
    },
  };
}

/** Standard JQL fields to request from search. */
const SEARCH_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "labels",
  "description",
  "updated",
  "created",
  "parent",
];

export function createJiraProvider(opts: JiraProviderOptions): RemoteProvider {
  const { callTool, defaultIssueType = "Task" } = opts;
  const SERVER = "atlassian";

  async function callAtlassian(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await callTool(SERVER, tool, args, 30_000);
    return unwrapToolResult(raw);
  }

  const provider: RemoteProvider = {
    name: "jira",

    async resolveScope(scope: Scope): Promise<ResolvedScope> {
      validateScopeKey(scope.key);
      let cloudId = scope.cloudId;
      let siteUrl: string | undefined;

      // Auto-discover cloudId if not provided
      if (!cloudId) {
        const resources = (await callAtlassian("getAccessibleAtlassianResources", {})) as ResourcesResponse[];
        if (!resources || (Array.isArray(resources) && resources.length === 0)) {
          throw new Error("No accessible Atlassian resources found. Check your authentication.");
        }
        if (Array.isArray(resources) && resources.length > 1) {
          console.error(
            `[jira] Warning: ${resources.length} Atlassian instances found (${resources.map((r) => r.name).join(", ")}). ` +
              `Using "${resources[0].name}". Pass --cloud-id explicitly to select a different instance.`,
          );
        }
        const resource = Array.isArray(resources) ? resources[0] : resources;
        cloudId = resource.id;
        siteUrl = resource.url;
      }

      return {
        key: scope.key,
        cloudId,
        resolved: {
          projectKey: scope.key,
          ...(siteUrl ? { siteUrl } : {}),
        },
      };
    },

    async *list(scope: ResolvedScope): AsyncIterable<RemoteEntry> {
      const jql = `project = "${scope.key}" ORDER BY key ASC`;
      let nextPageToken: string | undefined;

      do {
        const args: Record<string, unknown> = {
          cloudId: scope.cloudId,
          jql,
          fields: SEARCH_FIELDS,
          responseContentFormat: "markdown",
          maxResults: 100,
        };
        if (nextPageToken) args.nextPageToken = nextPageToken;

        const resp = (await callAtlassian("searchJiraIssuesUsingJql", args)) as JiraSearchResponse;

        for (const issue of resp.issues ?? []) {
          yield toRemoteEntry(issue);
        }

        nextPageToken = resp.nextPageToken;
      } while (nextPageToken);
    },

    async fetch(scope: ResolvedScope, id: string): Promise<FetchResult> {
      const resp = (await callAtlassian("getJiraIssue", {
        cloudId: scope.cloudId,
        issueIdOrKey: id,
        responseContentFormat: "markdown",
      })) as JiraIssue;

      const entry = toRemoteEntry(resp);
      return {
        content: entry.content ?? "",
        entry,
      };
    },

    async *changes(scope: ResolvedScope, since: string): AsyncIterable<ChangeEvent> {
      // Convert ISO timestamp to JQL date format (yyyy-MM-dd HH:mm) using UTC to avoid timezone drift
      const sinceDate = new Date(since);
      const jqlDate = `${sinceDate.getUTCFullYear()}-${String(sinceDate.getUTCMonth() + 1).padStart(2, "0")}-${String(sinceDate.getUTCDate()).padStart(2, "0")} ${String(sinceDate.getUTCHours()).padStart(2, "0")}:${String(sinceDate.getUTCMinutes()).padStart(2, "0")}`;

      const jql = `project = "${scope.key}" AND updated >= "${jqlDate}" ORDER BY updated DESC`;
      let nextPageToken: string | undefined;

      do {
        const args: Record<string, unknown> = {
          cloudId: scope.cloudId,
          jql,
          fields: SEARCH_FIELDS,
          responseContentFormat: "markdown",
          maxResults: 100,
        };
        if (nextPageToken) args.nextPageToken = nextPageToken;

        const resp = (await callAtlassian("searchJiraIssuesUsingJql", args)) as JiraSearchResponse;

        for (const issue of resp.issues ?? []) {
          yield {
            entry: toRemoteEntry(issue),
            type: "updated",
          };
        }

        nextPageToken = resp.nextPageToken;
      } while (nextPageToken);
    },

    toPath(entry: RemoteEntry, _entries: RemoteEntry[]): string {
      // Flat structure: issue key is the filename
      return `${entry.id}.md`;
    },

    frontmatter(entry: RemoteEntry, scope: ResolvedScope): Record<string, unknown> {
      const m = entry.metadata;
      const siteUrl = (scope.resolved.siteUrl as string) ?? `https://${scope.cloudId}.atlassian.net`;
      return {
        key: entry.id,
        id: m.numericId as string,
        summary: entry.title,
        status: m.status,
        type: m.type,
        priority: m.priority,
        assignee: m.assignee,
        labels: m.labels,
        ...(m.parent ? { parent: m.parent } : {}),
        updated: entry.lastModified,
        url: `${siteUrl.replace(/\/$/, "")}/browse/${entry.id}`,
      };
    },

    async push(
      scope: ResolvedScope,
      id: string,
      content: string,
      baseVersion: number,
      frontmatter?: Record<string, unknown>,
    ) {
      try {
        // Fetch current issue to check for conflicts via updated timestamp
        const current = (await callAtlassian("getJiraIssue", {
          cloudId: scope.cloudId,
          issueIdOrKey: id,
          responseContentFormat: "markdown",
        })) as JiraIssue;

        const currentVersion = new Date(current.fields.updated).getTime();
        if (Number.isNaN(currentVersion)) {
          return {
            ok: false,
            error: `Cannot determine remote version for issue ${id}: 'updated' field is missing or malformed.`,
          };
        }
        if (currentVersion > baseVersion) {
          return {
            ok: false,
            error: `Version conflict: issue ${id} was updated remotely (${current.fields.updated}). Pull first to get the latest version.`,
          };
        }

        // Build fields to push — always include description, plus any editable frontmatter fields
        const fields: Record<string, unknown> = { description: content };
        if (frontmatter?.summary && frontmatter.summary !== current.fields.summary) {
          fields.summary = frontmatter.summary;
        }

        await callAtlassian("editJiraIssue", {
          cloudId: scope.cloudId,
          issueIdOrKey: id,
          fields,
          contentFormat: "markdown",
        });

        // Fetch the updated issue to get the new timestamp
        const updated = (await callAtlassian("getJiraIssue", {
          cloudId: scope.cloudId,
          issueIdOrKey: id,
          responseContentFormat: "markdown",
        })) as JiraIssue;

        return {
          ok: true,
          newVersion: new Date(updated.fields.updated).getTime(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },

    async create(scope: ResolvedScope, parentId: string | undefined, title: string, content: string) {
      const args: Record<string, unknown> = {
        cloudId: scope.cloudId,
        projectKey: scope.key,
        issueTypeName: defaultIssueType,
        summary: title,
        description: content,
        contentFormat: "markdown",
      };
      if (parentId) args.parent = parentId;

      const resp = (await callAtlassian("createJiraIssue", args)) as JiraIssue;
      return toRemoteEntry(resp);
    },
  };

  return provider;
}
