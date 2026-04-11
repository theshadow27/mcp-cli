/**
 * Asana provider — maps an Asana project to a local directory of markdown task files.
 *
 * Layout:
 *   project-name/
 *     Section A/
 *       task-title.md
 *     Section B/
 *       subtask-parent/
 *         _index.md
 *         child-task.md
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

/** Shape of an Asana task from the API. */
interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  html_notes?: string;
  completed: boolean;
  due_on?: string;
  due_at?: string;
  assignee?: { gid: string; name?: string; email?: string } | null;
  memberships?: Array<{ section?: { gid: string; name: string } }>;
  tags?: Array<{ gid: string; name: string }>;
  parent?: { gid: string; name?: string } | null;
  permalink_url?: string;
  modified_at?: string;
  created_at?: string;
  num_subtasks?: number;
}

/** Shape of an Asana section. */
interface AsanaSection {
  gid: string;
  name: string;
}

/** Shape of an Asana project. */
interface AsanaProject {
  gid: string;
  name: string;
  workspace?: { gid: string; name?: string };
  permalink_url?: string;
}

/** Options for creating the Asana provider. */
export interface AsanaProviderOptions {
  /** Function to call an MCP tool: (server, tool, args, timeoutMs?) → result */
  callTool: McpToolCaller;
}

/** Sanitize a title for use as a filename. */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, "_") // filesystem-unsafe chars
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

/** Validate scope key — must be a numeric project GID or alphanumeric slug. */
function validateScopeKey(key: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(`Invalid scope key "${key}": must contain only alphanumeric characters, hyphens, and underscores.`);
  }
}

/** Deterministic sentinel for tasks with no timestamp — avoids re-syncing on every poll. */
const EPOCH_SENTINEL = "1970-01-01T00:00:00.000Z";

/** Convert an Asana task to a RemoteEntry. */
function toRemoteEntry(task: AsanaTask, sectionName?: string): RemoteEntry {
  const lastModified = task.modified_at ?? task.created_at ?? EPOCH_SENTINEL;
  return {
    id: task.gid,
    title: task.name,
    parentId: task.parent?.gid,
    version: new Date(lastModified).getTime(), // Use modified_at timestamp as version for conflict detection
    lastModified,
    content: task.notes ?? "",
    metadata: {
      completed: task.completed,
      assignee: task.assignee?.email ?? task.assignee?.name ?? null,
      due_date: task.due_on ?? task.due_at ?? null,
      tags: (task.tags ?? []).map((t) => t.name),
      section: sectionName ?? task.memberships?.[0]?.section?.name ?? null,
      sectionGid: task.memberships?.[0]?.section?.gid ?? null,
      permalink_url: task.permalink_url ?? null,
      num_subtasks: task.num_subtasks ?? 0,
    },
  };
}

export function createAsanaProvider(opts: AsanaProviderOptions): RemoteProvider {
  const { callTool } = opts;
  const SERVER = "asana";

  async function callAsana(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await callTool(SERVER, tool, args, 30_000);
    return unwrapToolResult(raw);
  }

  const provider: RemoteProvider = {
    name: "asana",

    async resolveScope(scope: Scope): Promise<ResolvedScope> {
      validateScopeKey(scope.key);

      // Fetch project details to validate and resolve metadata
      const project = (await callAsana("getProject", { project_gid: scope.key })) as AsanaProject;

      if (!project?.gid) {
        throw new Error(`Project "${scope.key}" not found. Check the project GID.`);
      }

      const workspaceId = scope.cloudId ?? project.workspace?.gid ?? "";

      return {
        key: scope.key,
        cloudId: workspaceId,
        resolved: {
          projectGid: project.gid,
          projectName: project.name,
          workspaceName: project.workspace?.name,
          baseUrl: project.permalink_url ?? "",
        },
      };
    },

    async *list(scope: ResolvedScope): AsyncIterable<RemoteEntry> {
      const projectGid = scope.resolved.projectGid as string;

      // Fetch sections first to build section name map
      const sectionsResp = (await callAsana("getSectionsForProject", {
        project_gid: projectGid,
      })) as { data: AsanaSection[] } | AsanaSection[];

      const sections = Array.isArray(sectionsResp)
        ? sectionsResp
        : ((sectionsResp as { data: AsanaSection[] }).data ?? []);

      const sectionMap = new Map<string, string>();
      for (const s of sections) {
        sectionMap.set(s.gid, s.name);
      }

      // Fetch tasks for the project with opt_fields for full metadata
      const tasksResp = (await callAsana("getTasksForProject", {
        project_gid: projectGid,
        opt_fields:
          "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,memberships.section,memberships.section.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
      })) as { data: AsanaTask[] } | AsanaTask[];

      const tasks = Array.isArray(tasksResp) ? tasksResp : ((tasksResp as { data: AsanaTask[] }).data ?? []);

      const MAX_SUBTASK_DEPTH = 5;

      // Recursively fetch subtasks up to MAX_SUBTASK_DEPTH levels
      async function* fetchSubtasks(
        parentGid: string,
        sectionName: string | undefined,
        depth: number,
      ): AsyncGenerator<RemoteEntry> {
        const subtasksResp = (await callAsana("getSubtasksForTask", {
          task_gid: parentGid,
          opt_fields:
            "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
        })) as { data: AsanaTask[] } | AsanaTask[];

        const subtasks = Array.isArray(subtasksResp)
          ? subtasksResp
          : ((subtasksResp as { data: AsanaTask[] }).data ?? []);

        for (const subtask of subtasks) {
          yield toRemoteEntry(subtask, sectionName);

          if ((subtask.num_subtasks ?? 0) > 0) {
            if (depth + 1 >= MAX_SUBTASK_DEPTH) {
              console.error(
                `[asana] Warning: subtask "${subtask.name}" (${subtask.gid}) has children beyond max depth ${MAX_SUBTASK_DEPTH}. Deeper levels are not fetched.`,
              );
            } else {
              yield* fetchSubtasks(subtask.gid, sectionName, depth + 1);
            }
          }
        }
      }

      for (const task of tasks) {
        const sectionName = task.memberships?.[0]?.section?.gid
          ? (sectionMap.get(task.memberships[0].section.gid) ?? task.memberships[0].section.name)
          : undefined;
        yield toRemoteEntry(task, sectionName);

        if ((task.num_subtasks ?? 0) > 0) {
          yield* fetchSubtasks(task.gid, sectionName, 0);
        }
      }
    },

    async fetch(scope: ResolvedScope, id: string): Promise<FetchResult> {
      const task = (await callAsana("getTask", {
        task_gid: id,
        opt_fields:
          "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,memberships.section,memberships.section.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
      })) as AsanaTask | { data: AsanaTask };

      const t = "data" in (task as { data: AsanaTask }) ? (task as { data: AsanaTask }).data : (task as AsanaTask);

      return {
        content: t.notes ?? "",
        entry: toRemoteEntry(t),
      };
    },

    async *changes(scope: ResolvedScope, since: string): AsyncIterable<ChangeEvent> {
      const projectGid = scope.resolved.projectGid as string;

      // Fetch sections for section name resolution
      const sectionsResp = (await callAsana("getSectionsForProject", {
        project_gid: projectGid,
      })) as { data: AsanaSection[] } | AsanaSection[];

      const sections = Array.isArray(sectionsResp)
        ? sectionsResp
        : ((sectionsResp as { data: AsanaSection[] }).data ?? []);

      const sectionMap = new Map<string, string>();
      for (const s of sections) {
        sectionMap.set(s.gid, s.name);
      }

      const tasksResp = (await callAsana("getTasksForProject", {
        project_gid: projectGid,
        modified_since: since,
        opt_fields:
          "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,memberships.section,memberships.section.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
      })) as { data: AsanaTask[] } | AsanaTask[];

      const tasks = Array.isArray(tasksResp) ? tasksResp : ((tasksResp as { data: AsanaTask[] }).data ?? []);

      const sinceDate = new Date(since);

      for (const task of tasks) {
        const sectionName = task.memberships?.[0]?.section?.gid
          ? (sectionMap.get(task.memberships[0].section.gid) ?? task.memberships[0].section.name)
          : undefined;

        // Determine if created or updated by comparing created_at to since
        const createdAt = task.created_at ? new Date(task.created_at) : null;
        const type: ChangeEvent["type"] = createdAt && createdAt > sinceDate ? "created" : "updated";

        yield {
          entry: { ...toRemoteEntry(task, sectionName), content: task.notes ?? "" },
          type,
        };

        // Also check subtasks for modifications
        if ((task.num_subtasks ?? 0) > 0) {
          const subtasksResp = (await callAsana("getSubtasksForTask", {
            task_gid: task.gid,
            opt_fields:
              "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
          })) as { data: AsanaTask[] } | AsanaTask[];

          const subtasks = Array.isArray(subtasksResp)
            ? subtasksResp
            : ((subtasksResp as { data: AsanaTask[] }).data ?? []);

          for (const subtask of subtasks) {
            const subModified = subtask.modified_at ? new Date(subtask.modified_at) : null;
            if (subModified && subModified > sinceDate) {
              const subCreatedAt = subtask.created_at ? new Date(subtask.created_at) : null;
              const subType: ChangeEvent["type"] = subCreatedAt && subCreatedAt > sinceDate ? "created" : "updated";

              yield {
                entry: { ...toRemoteEntry(subtask, sectionName), content: subtask.notes ?? "" },
                type: subType,
              };
            }
          }
        }
      }
    },

    toPath: (() => {
      // Cache indexes across calls for the same entries array to avoid O(n^2)
      let cachedEntries: RemoteEntry[] | null = null;
      let entryById: Map<string, RemoteEntry>;
      let childSet: Set<string>;
      let sanitizedNames: Map<string, string>;

      function buildIndex(entries: RemoteEntry[]) {
        if (cachedEntries === entries) return;
        cachedEntries = entries;
        entryById = new Map(entries.map((e) => [e.id, e]));
        childSet = new Set<string>();
        sanitizedNames = new Map<string, string>();
        for (const e of entries) {
          if (e.parentId) childSet.add(e.parentId);
          sanitizedNames.set(e.id, sanitizeFilename(e.title));
        }
      }

      return function toPath(entry: RemoteEntry, entries: RemoteEntry[]): string {
        buildIndex(entries);

        const sectionName = entry.metadata.section as string | null;
        const hasChildren = childSet.has(entry.id);
        const segments: string[] = [];

        if (sectionName) {
          segments.push(sanitizeFilename(sectionName));
        }

        if (entry.parentId) {
          const parent = entryById.get(entry.parentId);
          if (parent) {
            segments.push(sanitizedNames.get(parent.id) ?? sanitizeFilename(parent.title));
          }
        }

        let name = sanitizedNames.get(entry.id) ?? sanitizeFilename(entry.title);

        // Disambiguate siblings with the same sanitized name
        const hasDuplicate = entries.some(
          (e) =>
            e.id !== entry.id &&
            e.parentId === entry.parentId &&
            (e.metadata.section as string | null) === sectionName &&
            (sanitizedNames.get(e.id) ?? sanitizeFilename(e.title)) === name,
        );
        if (hasDuplicate) {
          name = `${name}-${entry.id}`;
        }

        if (hasChildren) {
          segments.push(name);
          segments.push("_index.md");
        } else {
          segments.push(`${name}.md`);
        }

        return segments.join("/");
      };
    })(),

    frontmatter(entry: RemoteEntry, scope: ResolvedScope): Record<string, unknown> {
      const meta = entry.metadata;
      return {
        id: entry.id,
        name: entry.title,
        section: meta.section ?? undefined,
        assignee: meta.assignee ?? undefined,
        due_date: meta.due_date ?? undefined,
        completed: meta.completed as boolean,
        tags: (meta.tags as string[])?.length > 0 ? meta.tags : undefined,
        url: (meta.permalink_url as string) ?? undefined,
      };
    },

    async push(scope: ResolvedScope, id: string, content: string, _baseVersion: number) {
      try {
        const resp = (await callAsana("updateTask", {
          task_gid: id,
          notes: content,
        })) as AsanaTask | { data: AsanaTask };

        const t = "data" in (resp as { data: AsanaTask }) ? (resp as { data: AsanaTask }).data : (resp as AsanaTask);
        const modifiedAt = t.modified_at ?? t.created_at ?? EPOCH_SENTINEL;

        return {
          ok: true,
          newVersion: new Date(modifiedAt).getTime(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },

    async create(scope: ResolvedScope, parentId: string | undefined, title: string, content: string) {
      const projectGid = scope.resolved.projectGid as string;
      const args: Record<string, unknown> = {
        name: title,
        notes: content,
      };
      if (parentId) {
        // Subtasks inherit project membership from their parent — setting both
        // causes the task to appear as both a top-level project member AND a subtask.
        args.parent = parentId;
      } else {
        args.projects = [projectGid];
      }

      const resp = (await callAsana("createTask", args)) as AsanaTask | { data: AsanaTask };
      const t = "data" in (resp as { data: AsanaTask }) ? (resp as { data: AsanaTask }).data : (resp as AsanaTask);

      return toRemoteEntry(t);
    },

    async delete(scope: ResolvedScope, id: string) {
      try {
        await callAsana("deleteTask", { task_gid: id });
      } catch (err) {
        throw new Error(
          `Failed to delete task ${id}: ${err instanceof Error ? err.message : String(err)}. Delete may not be supported by your Asana MCP server.`,
        );
      }
    },
  };

  return provider;
}
