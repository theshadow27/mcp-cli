import { describe, expect, test } from "bun:test";
import { createAsanaProvider } from "./asana";
import type { ChangeEvent, RemoteEntry, ResolvedScope } from "./provider";

function makeScope(key = "1234567890"): ResolvedScope {
  return {
    key,
    cloudId: "workspace-123",
    resolved: {
      projectGid: "1234567890",
      projectName: "Test Project",
      workspaceName: "Test Workspace",
      baseUrl: "https://app.asana.com/0/1234567890",
    },
  };
}

function makeEntry(overrides: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    id: "task-1",
    title: "My Task",
    version: new Date("2026-01-01T00:00:00Z").getTime(),
    lastModified: "2026-01-01T00:00:00Z",
    metadata: {
      completed: false,
      assignee: null,
      due_date: null,
      tags: [],
      section: null,
      sectionGid: null,
      permalink_url: null,
      num_subtasks: 0,
    },
    ...overrides,
  };
}

/** Tracks calls with arguments for assertion. */
function makeCallTool(responses: Record<string, unknown> = {}): {
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  return {
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return responses[tool] ?? null;
    },
    calls,
  };
}

function makeTask(
  gid: string,
  name: string,
  overrides: Partial<{
    notes: string;
    completed: boolean;
    section: { gid: string; name: string };
    parent: { gid: string; name: string } | null;
    num_subtasks: number;
    tags: Array<{ gid: string; name: string }>;
    assignee: { gid: string; email: string; name: string } | null;
    due_on: string | null;
    permalink_url: string;
    modified_at: string;
    created_at: string;
  }> = {},
) {
  return {
    gid,
    name,
    notes: overrides.notes ?? `Notes for ${name}`,
    completed: overrides.completed ?? false,
    due_on: overrides.due_on ?? null,
    assignee: overrides.assignee ?? null,
    memberships: overrides.section ? [{ section: overrides.section }] : [],
    tags: overrides.tags ?? [],
    parent: overrides.parent ?? null,
    permalink_url: overrides.permalink_url ?? `https://app.asana.com/0/proj/${gid}`,
    modified_at: overrides.modified_at ?? "2026-01-01T00:00:00Z",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    num_subtasks: overrides.num_subtasks ?? 0,
  };
}

function wrapMcpResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function wrapMcpError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

describe("validateScopeKey (via resolveScope)", () => {
  test("rejects keys with special characters", async () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    await expect(provider.resolveScope({ key: "foo bar" })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with quotes", async () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    await expect(provider.resolveScope({ key: '"injection' })).rejects.toThrow("Invalid scope key");
  });

  test("accepts numeric project GIDs", async () => {
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getProject") {
          return {
            gid: "1234567890",
            name: "My Project",
            workspace: { gid: "ws-1", name: "My Workspace" },
            permalink_url: "https://app.asana.com/0/1234567890",
          };
        }
        return null;
      },
    });
    const resolved = await provider.resolveScope({ key: "1234567890" });
    expect(resolved.key).toBe("1234567890");
    expect(resolved.resolved.projectGid).toBe("1234567890");
  });
});

describe("resolveScope", () => {
  test("resolves project and workspace metadata", async () => {
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getProject") {
          return {
            gid: "proj-1",
            name: "My Project",
            workspace: { gid: "ws-1", name: "My Workspace" },
            permalink_url: "https://app.asana.com/0/proj-1",
          };
        }
        return null;
      },
    });

    const resolved = await provider.resolveScope({ key: "proj-1" });
    expect(resolved.cloudId).toBe("ws-1");
    expect(resolved.resolved.projectName).toBe("My Project");
    expect(resolved.resolved.workspaceName).toBe("My Workspace");
  });

  test("uses provided cloudId over workspace from project", async () => {
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getProject") {
          return {
            gid: "proj-1",
            name: "My Project",
            workspace: { gid: "ws-1", name: "My Workspace" },
          };
        }
        return null;
      },
    });

    const resolved = await provider.resolveScope({ key: "proj-1", cloudId: "override-ws" });
    expect(resolved.cloudId).toBe("override-ws");
  });

  test("throws when project not found", async () => {
    const provider = createAsanaProvider({
      callTool: async () => null,
    });
    await expect(provider.resolveScope({ key: "nonexistent" })).rejects.toThrow("not found");
  });
});

describe("unwrapToolResult — isError handling", () => {
  test("throws on MCP error response", async () => {
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getProject") {
          return wrapMcpError("Rate limit exceeded");
        }
        return null;
      },
    });

    await expect(provider.resolveScope({ key: "proj-1" })).rejects.toThrow("MCP tool error: Rate limit exceeded");
  });

  test("throws on isError during list", async () => {
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpError("403 Forbidden");
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    await expect(async () => {
      for await (const entry of provider.list(makeScope())) {
        entries.push(entry);
      }
    }).toThrow("MCP tool error");
  });
});

describe("toPath", () => {
  test("task with no section or parent returns <title>.md", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const entry = makeEntry({ id: "t1", title: "My Task", metadata: { ...makeEntry().metadata, section: null } });
    const result = provider.toPath(entry, [entry]);
    expect(result).toBe("My Task.md");
  });

  test("task in a section returns Section/<title>.md", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const entry = makeEntry({
      id: "t1",
      title: "My Task",
      metadata: { ...makeEntry().metadata, section: "To Do" },
    });
    const result = provider.toPath(entry, [entry]);
    expect(result).toBe("To Do/My Task.md");
  });

  test("task with children returns <title>/_index.md", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const parent = makeEntry({ id: "t1", title: "Parent Task", metadata: { ...makeEntry().metadata, section: null } });
    const child = makeEntry({
      id: "t2",
      title: "Child Task",
      parentId: "t1",
      metadata: { ...makeEntry().metadata, section: null },
    });
    const result = provider.toPath(parent, [parent, child]);
    expect(result).toBe("Parent Task/_index.md");
  });

  test("subtask builds path under parent directory", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const parent = makeEntry({ id: "t1", title: "Parent", metadata: { ...makeEntry().metadata, section: "Done" } });
    const child = makeEntry({
      id: "t2",
      title: "Child",
      parentId: "t1",
      metadata: { ...makeEntry().metadata, section: "Done" },
    });
    const result = provider.toPath(child, [parent, child]);
    expect(result).toBe("Done/Parent/Child.md");
  });

  test("disambiguates siblings with same title", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const t1 = makeEntry({ id: "t1", title: "Duplicate", metadata: { ...makeEntry().metadata, section: null } });
    const t2 = makeEntry({ id: "t2", title: "Duplicate", metadata: { ...makeEntry().metadata, section: null } });
    const r1 = provider.toPath(t1, [t1, t2]);
    const r2 = provider.toPath(t2, [t1, t2]);
    expect(r1).toBe("Duplicate-t1.md");
    expect(r2).toBe("Duplicate-t2.md");
  });

  test("sanitizes unsafe characters in title", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const entry = makeEntry({
      id: "t1",
      title: 'Task: "Fix" <bugs>',
      metadata: { ...makeEntry().metadata, section: null },
    });
    const result = provider.toPath(entry, [entry]);
    expect(result).not.toContain(":");
    expect(result).not.toContain('"');
    expect(result).not.toContain("<");
    expect(result).toMatch(/\.md$/);
  });
});

describe("frontmatter", () => {
  test("returns expected fields", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const scope = makeScope();
    const entry = makeEntry({
      id: "t1",
      title: "Test Task",
      metadata: {
        completed: false,
        assignee: "user@example.com",
        due_date: "2026-04-15",
        tags: ["urgent", "backend"],
        section: "To Do",
        sectionGid: "sec-1",
        permalink_url: "https://app.asana.com/0/proj/t1",
        num_subtasks: 0,
      },
    });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.id).toBe("t1");
    expect(fm.name).toBe("Test Task");
    expect(fm.section).toBe("To Do");
    expect(fm.assignee).toBe("user@example.com");
    expect(fm.due_date).toBe("2026-04-15");
    expect(fm.completed).toBe(false);
    expect(fm.tags).toEqual(["urgent", "backend"]);
    expect(fm.url).toBe("https://app.asana.com/0/proj/t1");
  });

  test("omits undefined optional fields", () => {
    const { callTool } = makeCallTool();
    const provider = createAsanaProvider({ callTool });
    const scope = makeScope();
    const entry = makeEntry({
      id: "t1",
      title: "Simple Task",
      metadata: {
        completed: true,
        assignee: null,
        due_date: null,
        tags: [],
        section: null,
        sectionGid: null,
        permalink_url: null,
        num_subtasks: 0,
      },
    });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.completed).toBe(true);
    expect(fm.section).toBeUndefined();
    expect(fm.assignee).toBeUndefined();
    expect(fm.due_date).toBeUndefined();
    expect(fm.tags).toBeUndefined();
  });
});

describe("list", () => {
  test("yields tasks from a project", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [{ gid: "sec-1", name: "To Do" }] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [
              makeTask("t1", "Task 1", { section: { gid: "sec-1", name: "To Do" } }),
              makeTask("t2", "Task 2", { section: { gid: "sec-1", name: "To Do" } }),
            ],
          });
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("Task 1");
    expect(entries[0].metadata.section).toBe("To Do");
  });

  test("fetches subtasks for tasks that have them", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [makeTask("t1", "Parent", { num_subtasks: 2 })],
          });
        }
        if (tool === "getSubtasksForTask") {
          expect((args as Record<string, unknown>).task_gid).toBe("t1");
          return wrapMcpResult({
            data: [
              makeTask("sub1", "Subtask 1", { parent: { gid: "t1", name: "Parent" } }),
              makeTask("sub2", "Subtask 2", { parent: { gid: "t1", name: "Parent" } }),
            ],
          });
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(3); // 1 parent + 2 subtasks
    expect(entries[1].parentId).toBe("t1");
    expect(entries[2].parentId).toBe("t1");
  });

  test("recursively fetches nested subtasks", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [makeTask("t1", "Root", { num_subtasks: 1 })],
          });
        }
        if (tool === "getSubtasksForTask") {
          const gid = (args as Record<string, unknown>).task_gid;
          if (gid === "t1") {
            return wrapMcpResult({
              data: [makeTask("sub1", "Child", { parent: { gid: "t1", name: "Root" }, num_subtasks: 1 })],
            });
          }
          if (gid === "sub1") {
            return wrapMcpResult({
              data: [makeTask("sub2", "Grandchild", { parent: { gid: "sub1", name: "Child" } })],
            });
          }
          return wrapMcpResult({ data: [] });
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(3); // Root + Child + Grandchild
    expect(entries[2].title).toBe("Grandchild");
    expect(entries[2].parentId).toBe("sub1");
  });

  test("handles array response format (no data wrapper)", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult([{ gid: "sec-1", name: "To Do" }]);
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult([makeTask("t1", "Task 1")]);
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
  });
});

describe("fetch", () => {
  test("fetches a single task by GID", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getTask") {
          return wrapMcpResult(makeTask("t1", "My Task", { notes: "# Hello\n\nWorld" }));
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "t1");
    expect(result.entry.id).toBe("t1");
    expect(result.entry.title).toBe("My Task");
    expect(result.content).toBe("# Hello\n\nWorld");
  });

  test("handles data-wrapped response", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getTask") {
          return wrapMcpResult({ data: makeTask("t1", "Wrapped", { notes: "content" }) });
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "t1");
    expect(result.entry.id).toBe("t1");
    expect(result.content).toBe("content");
  });
});

describe("changes", () => {
  test("yields changed tasks since timestamp", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          expect((args as Record<string, unknown>).modified_since).toBe("2026-01-01T00:00:00Z");
          return wrapMcpResult({
            data: [makeTask("t1", "Changed Task", { notes: "updated content" })],
          });
        }
        return null;
      },
    });

    const changesMethod = provider.changes as NonNullable<typeof provider.changes>;
    const changes: ChangeEvent[] = [];
    for await (const change of changesMethod(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(1);
  });

  test("classifies new tasks as created", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [
              // created_at is after the since timestamp
              makeTask("t1", "New Task", { created_at: "2026-03-01T00:00:00Z", modified_at: "2026-03-01T00:00:00Z" }),
            ],
          });
        }
        return null;
      },
    });

    const changesMethod = provider.changes as NonNullable<typeof provider.changes>;
    const changes: ChangeEvent[] = [];
    for await (const change of changesMethod(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("created");
  });

  test("classifies old tasks as updated", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [
              // created_at is before the since timestamp
              makeTask("t1", "Old Task", { created_at: "2025-06-01T00:00:00Z", modified_at: "2026-03-01T00:00:00Z" }),
            ],
          });
        }
        return null;
      },
    });

    const changesMethod = provider.changes as NonNullable<typeof provider.changes>;
    const changes: ChangeEvent[] = [];
    for await (const change of changesMethod(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("updated");
  });

  test("includes modified subtasks", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [makeTask("t1", "Parent", { num_subtasks: 1, modified_at: "2026-03-01T00:00:00Z" })],
          });
        }
        if (tool === "getSubtasksForTask") {
          return wrapMcpResult({
            data: [
              makeTask("sub1", "Modified Sub", {
                parent: { gid: "t1", name: "Parent" },
                modified_at: "2026-03-01T00:00:00Z",
                created_at: "2025-06-01T00:00:00Z",
              }),
            ],
          });
        }
        return null;
      },
    });

    const changesMethod = provider.changes as NonNullable<typeof provider.changes>;
    const changes: ChangeEvent[] = [];
    for await (const change of changesMethod(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(2); // parent + subtask
    expect(changes[1].entry.id).toBe("sub1");
    expect(changes[1].type).toBe("updated");
  });
});

describe("push", () => {
  test("returns ok: true and passes correct args", async () => {
    const scope = makeScope();
    const { callTool, calls } = makeCallTool({
      updateTask: wrapMcpResult(
        makeTask("t1", "Task", { notes: "updated content", modified_at: "2026-03-15T00:00:00Z" }),
      ),
    });
    const provider = createAsanaProvider({ callTool });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "t1", "updated content", 1);
    expect(result.ok).toBe(true);
    expect(result.newVersion).toBe(new Date("2026-03-15T00:00:00Z").getTime());

    // Verify correct arguments were passed
    const updateCall = calls.find((c) => c.tool === "updateTask");
    expect(updateCall?.args.task_gid).toBe("t1");
    expect(updateCall?.args.notes).toBe("updated content");
  });

  test("returns ok: false with error on failure", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async () => {
        throw new Error("Permission denied");
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "t1", "content", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Permission denied");
  });
});

describe("create", () => {
  test("creates a top-level task with project, not parent", async () => {
    const scope = makeScope();
    const { callTool, calls } = makeCallTool({
      createTask: wrapMcpResult(makeTask("new-1", "New Task")),
    });
    const provider = createAsanaProvider({ callTool });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    const entry = await createFn(scope, undefined, "New Task", "Task content");
    expect(entry.id).toBe("new-1");
    expect(entry.title).toBe("New Task");

    // Verify args: projects set, no parent
    const createCall = calls.find((c) => c.tool === "createTask");
    expect(createCall?.args.name).toBe("New Task");
    expect(createCall?.args.notes).toBe("Task content");
    expect(createCall?.args.projects).toEqual(["1234567890"]);
    expect(createCall?.args.parent).toBeUndefined();
  });

  test("creates a subtask with parent, not projects", async () => {
    const scope = makeScope();
    const { callTool, calls } = makeCallTool({
      createTask: wrapMcpResult(makeTask("new-1", "Subtask")),
    });
    const provider = createAsanaProvider({ callTool });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    await createFn(scope, "parent-1", "Subtask", "content");

    // Verify args: parent set, no projects
    const createCall = calls.find((c) => c.tool === "createTask");
    expect(createCall?.args.parent).toBe("parent-1");
    expect(createCall?.args.projects).toBeUndefined();
  });
});

describe("delete", () => {
  test("calls deleteTask with correct task_gid", async () => {
    const scope = makeScope();
    const { callTool, calls } = makeCallTool();
    const provider = createAsanaProvider({ callTool });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await deleteFn(scope, "t1");

    const deleteCall = calls.find((c) => c.tool === "deleteTask");
    expect(deleteCall?.args.task_gid).toBe("t1");
  });

  test("throws on API error", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async () => {
        throw new Error("Not found");
      },
    });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await expect(deleteFn(scope, "t1")).rejects.toThrow("Failed to delete task t1");
  });
});

describe("version from modified_at", () => {
  test("uses modified_at timestamp as version", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getSectionsForProject") {
          return wrapMcpResult({ data: [] });
        }
        if (tool === "getTasksForProject") {
          return wrapMcpResult({
            data: [makeTask("t1", "Task", { modified_at: "2026-03-15T12:00:00Z" })],
          });
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries[0].version).toBe(new Date("2026-03-15T12:00:00Z").getTime());
  });

  test("uses epoch sentinel when no timestamps available", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getTask") {
          return wrapMcpResult({
            gid: "t1",
            name: "No Dates",
            notes: "",
            completed: false,
            // No modified_at or created_at
          });
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "t1");
    expect(result.entry.lastModified).toBe("1970-01-01T00:00:00.000Z");
    expect(result.entry.version).toBe(0);
  });
});
