import { describe, expect, test } from "bun:test";
import { createJiraProvider } from "./jira";
import type { RemoteEntry, ResolvedScope } from "./provider";

function makeScope(key = "FOO"): ResolvedScope {
  return {
    key,
    cloudId: "cloud-123",
    resolved: { projectKey: key },
  };
}

function makeEntry(overrides: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    id: "FOO-1",
    title: "Test Issue",
    version: new Date("2026-01-01T00:00:00Z").getTime(),
    lastModified: "2026-01-01T00:00:00Z",
    metadata: {
      numericId: "10001",
      status: "In Progress",
      type: "Task",
      priority: "High",
      assignee: "Jane Developer",
      labels: ["auth"],
      created: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

function makeIssueResponse(key: string, summary: string, updated = "2026-01-01T00:00:00Z") {
  return {
    id: "10001",
    key,
    fields: {
      summary,
      status: { name: "In Progress" },
      issuetype: { name: "Task" },
      priority: { name: "High" },
      assignee: { displayName: "Jane Developer" },
      labels: ["auth"],
      description: `# ${summary}\n\nDescription content.`,
      updated,
      created: "2026-01-01T00:00:00Z",
      parent: undefined,
    },
  };
}

function wrapMcpResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

describe("validateScopeKey (via resolveScope)", () => {
  function makeCallTool(): (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown> {
    return async () => null;
  }

  test("rejects keys with double-quotes (JQL injection)", async () => {
    const provider = createJiraProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: '"OR 1=1--' })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with spaces", async () => {
    const provider = createJiraProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "FOO BAR" })).rejects.toThrow("Invalid scope key");
  });

  test("accepts alphanumeric keys", async () => {
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getAccessibleAtlassianResources") {
          return [{ id: "cloud-1", url: "https://example.atlassian.net", name: "Example", scopes: [] }];
        }
        return null;
      },
    });
    const resolved = await provider.resolveScope({ key: "FOO123" });
    expect(resolved.key).toBe("FOO123");
    expect(resolved.cloudId).toBe("cloud-1");
  });

  test("uses provided cloudId without auto-discovery", async () => {
    let calledResources = false;
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getAccessibleAtlassianResources") calledResources = true;
        return null;
      },
    });
    const resolved = await provider.resolveScope({ key: "FOO", cloudId: "my-cloud" });
    expect(resolved.cloudId).toBe("my-cloud");
    expect(calledResources).toBe(false);
  });
});

describe("toPath", () => {
  test("returns issue key as filename", () => {
    const provider = createJiraProvider({ callTool: async () => null });
    const entry = makeEntry({ id: "FOO-1234" });
    expect(provider.toPath(entry, [entry])).toBe("FOO-1234.md");
  });

  test("ignores other entries (flat structure)", () => {
    const provider = createJiraProvider({ callTool: async () => null });
    const e1 = makeEntry({ id: "FOO-1" });
    const e2 = makeEntry({ id: "FOO-2" });
    expect(provider.toPath(e1, [e1, e2])).toBe("FOO-1.md");
    expect(provider.toPath(e2, [e1, e2])).toBe("FOO-2.md");
  });
});

describe("frontmatter", () => {
  test("returns expected fields", () => {
    const provider = createJiraProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry({
      id: "FOO-1234",
      title: "Fix authentication timeout",
      metadata: {
        numericId: "10001",
        status: "In Progress",
        type: "Task",
        priority: "High",
        assignee: "Jane Developer",
        labels: ["auth", "captain"],
        parent: "FOO-1000",
      },
    });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.key).toBe("FOO-1234");
    expect(fm.id).toBe("10001");
    expect(fm.summary).toBe("Fix authentication timeout");
    expect(fm.status).toBe("In Progress");
    expect(fm.type).toBe("Task");
    expect(fm.priority).toBe("High");
    expect(fm.assignee).toBe("Jane Developer");
    expect(fm.labels).toEqual(["auth", "captain"]);
    expect(fm.parent).toBe("FOO-1000");
    expect(fm.url).toContain("FOO-1234");
  });

  test("omits parent field when not present", () => {
    const provider = createJiraProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry({ metadata: { numericId: "10001", labels: [] } });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.parent).toBeUndefined();
  });
});

describe("list", () => {
  test("yields all issues from a single response", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "searchJiraIssuesUsingJql") {
          return wrapMcpResult({
            issues: [makeIssueResponse("FOO-1", "Issue 1"), makeIssueResponse("FOO-2", "Issue 2")],
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
    expect(entries[0].id).toBe("FOO-1");
    expect(entries[1].id).toBe("FOO-2");
  });

  test("paginates via nextPageToken", async () => {
    const scope = makeScope();
    let callCount = 0;
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "searchJiraIssuesUsingJql") {
          callCount++;
          if (callCount === 1) {
            return wrapMcpResult({
              issues: [makeIssueResponse("FOO-1", "Issue 1")],
              nextPageToken: "page2",
            });
          }
          return wrapMcpResult({
            issues: [makeIssueResponse("FOO-2", "Issue 2")],
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
    expect(callCount).toBe(2);
  });

  test("includes inline content from description", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "searchJiraIssuesUsingJql") {
          return wrapMcpResult({
            issues: [makeIssueResponse("FOO-1", "Issue 1")],
          });
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries[0].content).toContain("Description content.");
  });
});

describe("fetch", () => {
  test("fetches a single issue by key", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getJiraIssue") {
          return wrapMcpResult(makeIssueResponse("FOO-1", "My Issue"));
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "FOO-1");
    expect(result.entry.id).toBe("FOO-1");
    expect(result.entry.title).toBe("My Issue");
    expect(result.content).toContain("My Issue");
  });
});

describe("push", () => {
  test("returns ok: true on success", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getJiraIssue") {
          // Return same timestamp on first check, then updated on re-fetch
          return wrapMcpResult(makeIssueResponse("FOO-1", "Issue", "2026-01-01T00:00:00Z"));
        }
        if (tool === "editJiraIssue") {
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "FOO-1", "Updated content", baseVersion);
    expect(result.ok).toBe(true);
  });

  test("detects conflict via updated timestamp", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getJiraIssue") {
          // Remote is newer than base
          return wrapMcpResult(makeIssueResponse("FOO-1", "Issue", "2026-02-01T00:00:00Z"));
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "FOO-1", "Content", baseVersion);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("conflict");
  });

  test("returns ok: false with error message on API error", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async () => {
        throw new Error("Network timeout");
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "FOO-1", "Content", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network timeout");
  });
});

describe("create", () => {
  test("creates a new issue and returns the entry", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "createJiraIssue") {
          return wrapMcpResult(makeIssueResponse("FOO-99", "New Issue"));
        }
        return null;
      },
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    const entry = await createFn(scope, undefined, "New Issue", "Content here");
    expect(entry.id).toBe("FOO-99");
    expect(entry.title).toBe("New Issue");
  });

  test("passes parent key for subtasks", async () => {
    const scope = makeScope();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createJiraProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "createJiraIssue") {
          capturedArgs = args;
          return wrapMcpResult(makeIssueResponse("FOO-100", "Subtask"));
        }
        return null;
      },
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    await createFn(scope, "FOO-1", "Subtask", "Sub content");
    expect(capturedArgs.parent).toBe("FOO-1");
  });
});

describe("changes", () => {
  test("yields changed issues since timestamp", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "searchJiraIssuesUsingJql") {
          return wrapMcpResult({
            issues: [makeIssueResponse("FOO-1", "Updated Issue", "2026-02-01T00:00:00Z")],
          });
        }
        return null;
      },
    });

    const changesFn = provider.changes as NonNullable<typeof provider.changes>;
    const changes: unknown[] = [];
    for await (const change of changesFn(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(1);
  });

  test("paginates changes via nextPageToken", async () => {
    const scope = makeScope();
    let callCount = 0;
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "searchJiraIssuesUsingJql") {
          callCount++;
          if (callCount === 1) {
            return wrapMcpResult({
              issues: [makeIssueResponse("FOO-1", "Issue 1")],
              nextPageToken: "next",
            });
          }
          return wrapMcpResult({
            issues: [makeIssueResponse("FOO-2", "Issue 2")],
          });
        }
        return null;
      },
    });

    const changesFn = provider.changes as NonNullable<typeof provider.changes>;
    const changes: unknown[] = [];
    for await (const change of changesFn(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});
