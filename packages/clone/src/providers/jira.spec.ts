import { describe, expect, test } from "bun:test";
import { createJiraProvider } from "./jira";
import type { RemoteEntry, ResolvedScope } from "./provider";

function makeScope(key = "FOO"): ResolvedScope {
  return {
    key,
    cloudId: "cloud-123",
    resolved: { projectKey: key, siteUrl: "https://mycompany.atlassian.net" },
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

function wrapMcpError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
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
    expect(fm.url).toBe("https://mycompany.atlassian.net/browse/FOO-1234");
  });

  test("uses siteUrl from resolved scope for URL, not cloudId", () => {
    const provider = createJiraProvider({ callTool: async () => null });
    const scope: ResolvedScope = {
      key: "FOO",
      cloudId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      resolved: { projectKey: "FOO", siteUrl: "https://acme.atlassian.net" },
    };
    const entry = makeEntry({ id: "FOO-42" });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.url).toBe("https://acme.atlassian.net/browse/FOO-42");
  });

  test("falls back to cloudId-based URL when siteUrl not in scope", () => {
    const provider = createJiraProvider({ callTool: async () => null });
    const scope: ResolvedScope = {
      key: "FOO",
      cloudId: "cloud-123",
      resolved: { projectKey: "FOO" },
    };
    const entry = makeEntry({ id: "FOO-42" });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.url).toBe("https://cloud-123.atlassian.net/browse/FOO-42");
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

  test("uses configurable defaultIssueType", async () => {
    const scope = makeScope();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createJiraProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "createJiraIssue") {
          capturedArgs = args;
          return wrapMcpResult(makeIssueResponse("FOO-101", "Story Issue"));
        }
        return null;
      },
      defaultIssueType: "Story",
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    await createFn(scope, undefined, "Story Issue", "Content");
    expect(capturedArgs.issueTypeName).toBe("Story");
  });
});

describe("push (frontmatter fields)", () => {
  test("pushes summary from frontmatter when changed", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    let capturedFields: Record<string, unknown> = {};
    const provider = createJiraProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "getJiraIssue") {
          return wrapMcpResult(makeIssueResponse("FOO-1", "Old Title", "2026-01-01T00:00:00Z"));
        }
        if (tool === "editJiraIssue") {
          capturedFields = args.fields as Record<string, unknown>;
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "FOO-1", "Updated body", baseVersion, { summary: "New Title" });
    expect(result.ok).toBe(true);
    expect(capturedFields.summary).toBe("New Title");
    expect(capturedFields.description).toBe("Updated body");
  });

  test("does not push summary when unchanged", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    let capturedFields: Record<string, unknown> = {};
    const provider = createJiraProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "getJiraIssue") {
          return wrapMcpResult(makeIssueResponse("FOO-1", "Same Title", "2026-01-01T00:00:00Z"));
        }
        if (tool === "editJiraIssue") {
          capturedFields = args.fields as Record<string, unknown>;
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    await pushFn(scope, "FOO-1", "Body", baseVersion, { summary: "Same Title" });
    expect(capturedFields.summary).toBeUndefined();
  });
});

describe("push (NaN version guard)", () => {
  test("returns error when remote updated field is malformed", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getJiraIssue") {
          return wrapMcpResult({
            id: "10001",
            key: "FOO-1",
            fields: {
              summary: "Issue",
              updated: "not-a-date",
              created: "2026-01-01T00:00:00Z",
            },
          });
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "FOO-1", "Content", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing or malformed");
  });
});

describe("toRemoteEntry (NaN guard)", () => {
  test("defaults version to 0 for null updated field", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getJiraIssue") {
          return wrapMcpResult({
            id: "10001",
            key: "FOO-1",
            fields: {
              summary: "Issue",
              description: "Body",
              updated: null,
              created: "2026-01-01T00:00:00Z",
            },
          });
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "FOO-1");
    expect(result.entry.version).toBe(0);
    expect(Number.isNaN(result.entry.version)).toBe(false);
  });
});

describe("resolveScope", () => {
  test("stores siteUrl from resources response", async () => {
    const provider = createJiraProvider({
      callTool: async (_server, tool) => {
        if (tool === "getAccessibleAtlassianResources") {
          return [{ id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme", scopes: [] }];
        }
        return null;
      },
    });
    const resolved = await provider.resolveScope({ key: "FOO" });
    expect(resolved.resolved.siteUrl).toBe("https://acme.atlassian.net");
  });

  test("warns on multiple resources but still resolves", async () => {
    const stderrMessages: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => stderrMessages.push(args.join(" "));
    try {
      const provider = createJiraProvider({
        callTool: async (_server, tool) => {
          if (tool === "getAccessibleAtlassianResources") {
            return [
              { id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme", scopes: [] },
              { id: "cloud-2", url: "https://corp.atlassian.net", name: "Corp", scopes: [] },
            ];
          }
          return null;
        },
      });
      const resolved = await provider.resolveScope({ key: "FOO" });
      expect(resolved.cloudId).toBe("cloud-1");
      expect(stderrMessages.some((m) => m.includes("2 Atlassian instances"))).toBe(true);
    } finally {
      console.error = origError;
    }
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

  test("formats JQL date in UTC", async () => {
    const scope = makeScope();
    let capturedJql = "";
    const provider = createJiraProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "searchJiraIssuesUsingJql") {
          capturedJql = args.jql as string;
          return wrapMcpResult({ issues: [] });
        }
        return null;
      },
    });

    const changesFn = provider.changes as NonNullable<typeof provider.changes>;
    // Use a timestamp where UTC and local time differ for most timezones
    for await (const _change of changesFn(scope, "2026-03-15T03:30:00Z")) {
      // drain
    }
    // The JQL date should be in UTC: 2026-03-15 03:30
    expect(capturedJql).toContain('updated >= "2026-03-15 03:30"');
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

describe("unwrapToolResult — isError handling", () => {
  test("throws on MCP error response during resolveScope", async () => {
    const provider = createJiraProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getAccessibleAtlassianResources") {
          return wrapMcpError("Rate limit exceeded");
        }
        return null;
      },
    });

    await expect(provider.resolveScope({ key: "FOO" })).rejects.toThrow("MCP tool error: Rate limit exceeded");
  });

  test("throws on isError during list", async () => {
    const scope = makeScope();
    const provider = createJiraProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "searchJiraIssuesUsingJql") {
          return wrapMcpError("403 Forbidden");
        }
        return null;
      },
    });

    const entries: unknown[] = [];
    await expect(async () => {
      for await (const entry of provider.list(scope)) {
        entries.push(entry);
      }
    }).toThrow("MCP tool error: 403 Forbidden");
  });
});
