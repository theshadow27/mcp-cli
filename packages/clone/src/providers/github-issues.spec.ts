import { describe, expect, test } from "bun:test";
import { createGitHubIssuesProvider } from "./github-issues";
import type { RemoteEntry, ResolvedScope } from "./provider";

function makeScope(key = "octocat/hello-world"): ResolvedScope {
  const [owner, repo] = key.split("/");
  return {
    key,
    cloudId: "github.com",
    resolved: { owner, repo },
  };
}

function makeEntry(overrides: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    id: "42",
    title: "Fix auth bug",
    version: new Date("2026-01-01T00:00:00Z").getTime(),
    lastModified: "2026-01-01T00:00:00Z",
    metadata: {
      numericId: 100042,
      number: 42,
      state: "open",
      labels: ["bug", "priority-high"],
      assignees: ["janedoe"],
      author: "octocat",
      url: "https://github.com/octocat/hello-world/issues/42",
      created: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

function makeIssueResponse(number: number, title: string, state = "open", updated = "2026-01-01T00:00:00Z") {
  return {
    id: 100000 + number,
    number,
    title,
    state,
    body: `# ${title}\n\nDescription content.`,
    labels: [{ name: "bug" }],
    assignees: [{ login: "janedoe" }],
    user: { login: "octocat" },
    html_url: `https://github.com/octocat/hello-world/issues/${number}`,
    updated_at: updated,
    created_at: "2026-01-01T00:00:00Z",
    milestone: null,
  };
}

function wrapMcpResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

describe("validateScopeKey (via resolveScope)", () => {
  function makeCallTool(): (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown> {
    return async () => null;
  }

  test("rejects keys without slash (not owner/repo)", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "just-a-repo" })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with spaces", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "my org/repo" })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with multiple slashes", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "a/b/c" })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with special characters", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: 'owner/"repo' })).rejects.toThrow("Invalid scope key");
  });

  test("accepts valid owner/repo keys", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    const resolved = await provider.resolveScope({ key: "octocat/hello-world" });
    expect(resolved.key).toBe("octocat/hello-world");
    expect(resolved.cloudId).toBe("github.com");
    expect(resolved.resolved.owner).toBe("octocat");
    expect(resolved.resolved.repo).toBe("hello-world");
  });

  test("accepts keys with dots and underscores", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    const resolved = await provider.resolveScope({ key: "my_org/my.repo" });
    expect(resolved.resolved.owner).toBe("my_org");
    expect(resolved.resolved.repo).toBe("my.repo");
  });

  test("uses provided cloudId", async () => {
    const provider = createGitHubIssuesProvider({ callTool: makeCallTool() });
    const resolved = await provider.resolveScope({ key: "octocat/hello-world", cloudId: "ghes.example.com" });
    expect(resolved.cloudId).toBe("ghes.example.com");
  });
});

describe("toPath", () => {
  test("returns state/number-slug.md for open issues", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const entry = makeEntry({
      id: "123",
      title: "Fix auth bug",
      metadata: { ...makeEntry().metadata, number: 123, state: "open" },
    });
    expect(provider.toPath(entry, [entry])).toBe("open/123-fix-auth-bug.md");
  });

  test("returns state/number-slug.md for closed issues", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const entry = makeEntry({
      id: "100",
      title: "Initial setup",
      metadata: { ...makeEntry().metadata, number: 100, state: "closed" },
    });
    expect(provider.toPath(entry, [entry])).toBe("closed/100-initial-setup.md");
  });

  test("sanitizes special characters in title", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const entry = makeEntry({
      id: "456",
      title: "feat(vfs): Add dark mode <3 !!",
      metadata: { ...makeEntry().metadata, number: 456, state: "open" },
    });
    expect(provider.toPath(entry, [entry])).toBe("open/456-feat-vfs-add-dark-mode-3.md");
  });

  test("truncates long titles", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const longTitle = "a".repeat(100);
    const entry = makeEntry({
      id: "789",
      title: longTitle,
      metadata: { ...makeEntry().metadata, number: 789, state: "open" },
    });
    const path = provider.toPath(entry, [entry]);
    // Slug portion (after number-) should be at most 60 chars
    const slug = path.replace("open/789-", "").replace(".md", "");
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});

describe("frontmatter", () => {
  test("returns expected fields", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry();
    const fm = provider.frontmatter(entry, scope);
    expect(fm.id).toBe(100042);
    expect(fm.number).toBe(42);
    expect(fm.title).toBe("Fix auth bug");
    expect(fm.state).toBe("open");
    expect(fm.labels).toEqual(["bug", "priority-high"]);
    expect(fm.assignees).toEqual(["janedoe"]);
    expect(fm.author).toBe("octocat");
    expect(fm.url).toBe("https://github.com/octocat/hello-world/issues/42");
  });

  test("omits author when not present", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry({
      metadata: { ...makeEntry().metadata, author: undefined },
    });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.author).toBeUndefined();
  });

  test("includes milestone when present", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry({
      metadata: { ...makeEntry().metadata, milestone: "v2.0" },
    });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.milestone).toBe("v2.0");
  });

  test("omits milestone when not present", () => {
    const provider = createGitHubIssuesProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry();
    const fm = provider.frontmatter(entry, scope);
    expect(fm.milestone).toBeUndefined();
  });
});

describe("list", () => {
  test("yields issues from both open and closed states", async () => {
    const scope = makeScope();
    let callCount = 0;
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "list_issues") {
          callCount++;
          const state = (args as Record<string, unknown>).state as string;
          if (state === "open") {
            return wrapMcpResult([makeIssueResponse(1, "Open Issue", "open")]);
          }
          if (state === "closed") {
            return wrapMcpResult([makeIssueResponse(2, "Closed Issue", "closed")]);
          }
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(entries[0].metadata.state).toBe("open");
    expect(entries[1].metadata.state).toBe("closed");
    expect(callCount).toBe(2);
  });

  test("paginates via page number", async () => {
    const scope = makeScope();
    let callCount = 0;
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "list_issues") {
          const a = args as Record<string, unknown>;
          if (a.state === "open") {
            callCount++;
            if (a.page === 1) {
              // Return exactly 100 to trigger pagination
              const issues = Array.from({ length: 100 }, (_, i) => makeIssueResponse(i + 1, `Issue ${i + 1}`, "open"));
              return wrapMcpResult(issues);
            }
            return wrapMcpResult([]);
          }
          // closed: empty
          return wrapMcpResult([]);
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(100);
    expect(callCount).toBe(2); // page 1 (100 results) + page 2 (0 results)
  });

  test("filters out pull requests", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "list_issues") {
          const a = args as Record<string, unknown>;
          if (a.state === "open") {
            return wrapMcpResult([
              makeIssueResponse(1, "Real Issue", "open"),
              { ...makeIssueResponse(2, "A PR", "open"), pull_request: { url: "..." } },
            ]);
          }
          return wrapMcpResult([]);
        }
        return null;
      },
    });

    const entries: RemoteEntry[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Real Issue");
  });
});

describe("fetch", () => {
  test("fetches a single issue by number", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "get_issue") {
          expect((args as Record<string, unknown>).issue_number).toBe(42);
          return wrapMcpResult(makeIssueResponse(42, "My Issue"));
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "42");
    expect(result.entry.id).toBe("42");
    expect(result.entry.title).toBe("My Issue");
    expect(result.content).toContain("My Issue");
  });
});

describe("push", () => {
  test("returns ok: true on success", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool) => {
        if (tool === "get_issue") {
          return wrapMcpResult(makeIssueResponse(1, "Issue", "open", "2026-01-01T00:00:00Z"));
        }
        if (tool === "update_issue") {
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "1", "Updated content", baseVersion);
    expect(result.ok).toBe(true);
  });

  test("detects conflict via updated_at timestamp", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool) => {
        if (tool === "get_issue") {
          return wrapMcpResult(makeIssueResponse(1, "Issue", "open", "2026-02-01T00:00:00Z"));
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "1", "Content", baseVersion);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("conflict");
  });

  test("returns ok: false with error on API error", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async () => {
        throw new Error("Network timeout");
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "1", "Content", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network timeout");
  });

  test("pushes title from frontmatter when changed", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "get_issue") {
          return wrapMcpResult(makeIssueResponse(1, "Old Title", "open", "2026-01-01T00:00:00Z"));
        }
        if (tool === "update_issue") {
          capturedArgs = args;
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    await pushFn(scope, "1", "Body", baseVersion, { title: "New Title" });
    expect(capturedArgs.title).toBe("New Title");
    expect(capturedArgs.body).toBe("Body");
  });

  test("does not push title when unchanged", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "get_issue") {
          return wrapMcpResult(makeIssueResponse(1, "Same Title", "open", "2026-01-01T00:00:00Z"));
        }
        if (tool === "update_issue") {
          capturedArgs = args;
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    await pushFn(scope, "1", "Body", baseVersion, { title: "Same Title" });
    expect(capturedArgs.title).toBeUndefined();
  });

  test("pushes state change from frontmatter", async () => {
    const scope = makeScope();
    const baseVersion = new Date("2026-01-01T00:00:00Z").getTime();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "get_issue") {
          return wrapMcpResult(makeIssueResponse(1, "Issue", "open", "2026-01-01T00:00:00Z"));
        }
        if (tool === "update_issue") {
          capturedArgs = args;
          return wrapMcpResult({});
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    await pushFn(scope, "1", "Body", baseVersion, { state: "closed" });
    expect(capturedArgs.state).toBe("closed");
  });

  test("returns error when updated_at is malformed", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool) => {
        if (tool === "get_issue") {
          return wrapMcpResult({
            ...makeIssueResponse(1, "Issue"),
            updated_at: "not-a-date",
          });
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "1", "Content", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing or malformed");
  });
});

describe("create", () => {
  test("creates a new issue and returns the entry", async () => {
    const scope = makeScope();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "create_issue") {
          capturedArgs = args;
          return wrapMcpResult(makeIssueResponse(99, "New Issue"));
        }
        return null;
      },
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    const entry = await createFn(scope, undefined, "New Issue", "Content here");
    expect(entry.id).toBe("99");
    expect(entry.title).toBe("New Issue");
    expect(capturedArgs.owner).toBe("octocat");
    expect(capturedArgs.repo).toBe("hello-world");
    expect(capturedArgs.title).toBe("New Issue");
    expect(capturedArgs.body).toBe("Content here");
  });
});

describe("changes", () => {
  test("yields changed issues since timestamp", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool) => {
        if (tool === "list_issues") {
          return wrapMcpResult([makeIssueResponse(1, "Updated Issue", "open", "2026-02-01T00:00:00Z")]);
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

  test("passes since parameter to API", async () => {
    const scope = makeScope();
    let capturedArgs: Record<string, unknown> = {};
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "list_issues") {
          capturedArgs = args;
          return wrapMcpResult([]);
        }
        return null;
      },
    });

    const changesFn = provider.changes as NonNullable<typeof provider.changes>;
    for await (const _change of changesFn(scope, "2026-03-15T03:30:00Z")) {
      // drain
    }
    expect(capturedArgs.since).toBe("2026-03-15T03:30:00Z");
    expect(capturedArgs.state).toBe("all");
  });

  test("filters out pull requests from changes", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool) => {
        if (tool === "list_issues") {
          return wrapMcpResult([
            makeIssueResponse(1, "Real Issue"),
            { ...makeIssueResponse(2, "A PR"), pull_request: { url: "..." } },
          ]);
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
});

describe("toRemoteEntry (NaN guard)", () => {
  test("defaults version to 0 for null updated_at", async () => {
    const scope = makeScope();
    const provider = createGitHubIssuesProvider({
      callTool: async (_server, tool) => {
        if (tool === "get_issue") {
          return wrapMcpResult({
            ...makeIssueResponse(1, "Issue"),
            updated_at: null,
          });
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "1");
    expect(result.entry.version).toBe(0);
    expect(Number.isNaN(result.entry.version)).toBe(false);
  });
});
