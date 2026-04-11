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
import type { ChangeEvent, FetchResult, RemoteEntry, RemoteProvider, ResolvedScope, Scope } from "./provider";

// Re-use shared types from confluence provider
import type { McpToolCaller } from "./confluence";

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

/** Convert an Asana task to a RemoteEntry. */
function toRemoteEntry(task: AsanaTask, sectionName?: string): RemoteEntry {
  return {
    id: task.gid,
    title: task.name,
    parentId: task.parent?.gid,
    version: 1, // Asana has no version numbers; we use modified_at for conflict detection
    lastModified: task.modified_at ?? task.created_at ?? new Date().toISOString(),
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

      // Also fetch subtasks for any task that has them
      const subtaskQueue: Array<{ parentTask: AsanaTask; sectionName?: string }> = [];

      for (const task of tasks) {
        const sectionName = task.memberships?.[0]?.section?.gid
          ? (sectionMap.get(task.memberships[0].section.gid) ?? task.memberships[0].section.name)
          : undefined;
        yield toRemoteEntry(task, sectionName);

        if ((task.num_subtasks ?? 0) > 0) {
          subtaskQueue.push({ parentTask: task, sectionName });
        }
      }

      // Fetch subtasks
      for (const { parentTask, sectionName } of subtaskQueue) {
        const subtasksResp = (await callAsana("getSubtasksForTask", {
          task_gid: parentTask.gid,
          opt_fields:
            "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
        })) as { data: AsanaTask[] } | AsanaTask[];

        const subtasks = Array.isArray(subtasksResp)
          ? subtasksResp
          : ((subtasksResp as { data: AsanaTask[] }).data ?? []);

        for (const subtask of subtasks) {
          // Subtasks inherit section from parent
          yield toRemoteEntry(subtask, sectionName);
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

      const tasksResp = (await callAsana("getTasksForProject", {
        project_gid: projectGid,
        modified_since: since,
        opt_fields:
          "gid,name,notes,completed,due_on,due_at,assignee,assignee.email,assignee.name,memberships.section,memberships.section.name,tags,tags.name,parent,parent.gid,permalink_url,modified_at,created_at,num_subtasks",
      })) as { data: AsanaTask[] } | AsanaTask[];

      const tasks = Array.isArray(tasksResp) ? tasksResp : ((tasksResp as { data: AsanaTask[] }).data ?? []);

      for (const task of tasks) {
        yield {
          entry: { ...toRemoteEntry(task), content: task.notes ?? "" },
          type: "updated",
        };
      }
    },

    toPath(entry: RemoteEntry, entries: RemoteEntry[]): string {
      const sectionName = entry.metadata.section as string | null;
      const hasChildren = entries.some((e) => e.parentId === entry.id);

      const segments: string[] = [];

      // Section as top-level directory
      if (sectionName) {
        segments.push(sanitizeFilename(sectionName));
      }

      // If this is a subtask, walk up parent chain (only one level — Asana subtasks are direct children)
      if (entry.parentId) {
        const entryById = new Map(entries.map((e) => [e.id, e]));
        const parent = entryById.get(entry.parentId);
        if (parent) {
          segments.push(sanitizeFilename(parent.title));
        }
      }

      let name = sanitizeFilename(entry.title);

      // Disambiguate siblings with the same sanitized name
      const siblings = entries.filter(
        (e) =>
          e.id !== entry.id &&
          e.parentId === entry.parentId &&
          (e.metadata.section as string | null) === sectionName &&
          sanitizeFilename(e.title) === name,
      );
      if (siblings.length > 0) {
        name = `${name}-${entry.id}`;
      }

      if (hasChildren) {
        segments.push(name);
        segments.push("_index.md");
      } else {
        segments.push(`${name}.md`);
      }

      return segments.join("/");
    },

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

        return {
          ok: true,
          newVersion: 1, // Asana doesn't version task content
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
        projects: [projectGid],
      };
      if (parentId) {
        args.parent = parentId;
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
