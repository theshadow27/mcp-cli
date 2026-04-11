import { describe, expect, test } from "bun:test";
import { createAsanaProvider } from "./asana";
import type { RemoteEntry, ResolvedScope } from "./provider";

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
    version: 1,
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

function makeCallTool(
  responses: Record<string, unknown> = {},
): (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (_server, tool, _args) => responses[tool] ?? null;
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
    modified_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    num_subtasks: overrides.num_subtasks ?? 0,
  };
}

function wrapMcpResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

describe("validateScopeKey (via resolveScope)", () => {
  test("rejects keys with special characters", async () => {
    const provider = createAsanaProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "foo bar" })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with quotes", async () => {
    const provider = createAsanaProvider({ callTool: makeCallTool() });
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

describe("toPath", () => {
  test("task with no section or parent returns <title>.md", () => {
    const provider = createAsanaProvider({ callTool: makeCallTool() });
    const entry = makeEntry({ id: "t1", title: "My Task", metadata: { ...makeEntry().metadata, section: null } });
    const result = provider.toPath(entry, [entry]);
    expect(result).toBe("My Task.md");
  });

  test("task in a section returns Section/<title>.md", () => {
    const provider = createAsanaProvider({ callTool: makeCallTool() });
    const entry = makeEntry({
      id: "t1",
      title: "My Task",
      metadata: { ...makeEntry().metadata, section: "To Do" },
    });
    const result = provider.toPath(entry, [entry]);
    expect(result).toBe("To Do/My Task.md");
  });

  test("task with children returns <title>/_index.md", () => {
    const provider = createAsanaProvider({ callTool: makeCallTool() });
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
    const provider = createAsanaProvider({ callTool: makeCallTool() });
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
    const provider = createAsanaProvider({ callTool: makeCallTool() });
    const t1 = makeEntry({ id: "t1", title: "Duplicate", metadata: { ...makeEntry().metadata, section: null } });
    const t2 = makeEntry({ id: "t2", title: "Duplicate", metadata: { ...makeEntry().metadata, section: null } });
    const r1 = provider.toPath(t1, [t1, t2]);
    const r2 = provider.toPath(t2, [t1, t2]);
    expect(r1).toBe("Duplicate-t1.md");
    expect(r2).toBe("Duplicate-t2.md");
  });

  test("sanitizes unsafe characters in title", () => {
    const provider = createAsanaProvider({ callTool: makeCallTool() });
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
    const provider = createAsanaProvider({ callTool: makeCallTool() });
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
    const provider = createAsanaProvider({ callTool: makeCallTool() });
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
    const changes: unknown[] = [];
    for await (const change of changesMethod(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(1);
  });
});

describe("push", () => {
  test("returns ok: true on success", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "updateTask") {
          return wrapMcpResult(makeTask("t1", "Task", { notes: "updated" }));
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "t1", "updated content", 1);
    expect(result.ok).toBe(true);
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
  test("creates a task and returns the entry", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "createTask") {
          const a = args as Record<string, unknown>;
          expect(a.name).toBe("New Task");
          expect(a.notes).toBe("Task content");
          expect((a.projects as string[])[0]).toBe("1234567890");
          return wrapMcpResult(makeTask("new-1", "New Task"));
        }
        return null;
      },
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    const entry = await createFn(scope, undefined, "New Task", "Task content");
    expect(entry.id).toBe("new-1");
    expect(entry.title).toBe("New Task");
  });

  test("passes parentId when provided", async () => {
    const scope = makeScope();
    const provider = createAsanaProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "createTask") {
          expect((args as Record<string, unknown>).parent).toBe("parent-1");
          return wrapMcpResult(makeTask("new-1", "Subtask"));
        }
        return null;
      },
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    await createFn(scope, "parent-1", "Subtask", "content");
  });
});

describe("delete", () => {
  test("calls deleteTask with task_gid", async () => {
    const scope = makeScope();
    const calls: string[] = [];
    const provider = createAsanaProvider({
      callTool: async (_server, tool, _args) => {
        calls.push(tool);
        return null;
      },
    });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await deleteFn(scope, "t1");
    expect(calls).toContain("deleteTask");
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
