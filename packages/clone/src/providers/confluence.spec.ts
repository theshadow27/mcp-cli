import { describe, expect, test } from "bun:test";
import { TruncatedChangesError, bulkFetchPages, createConfluenceProvider } from "./confluence";
import type { RemoteEntry, ResolvedScope } from "./provider";

function makeScope(key = "TEST"): ResolvedScope {
  return {
    key,
    cloudId: "cloud-123",
    resolved: { spaceId: "space-456", spaceName: "Test Space", homepageId: "home-1", baseUrl: "https://example.com" },
  };
}

function makeEntry(overrides: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    id: "page-1",
    title: "My Page",
    version: 1,
    lastModified: "2026-01-01T00:00:00Z",
    metadata: {},
    ...overrides,
  };
}

describe("TruncatedChangesError", () => {
  test("has correct name and message", () => {
    const err = new TruncatedChangesError(400, 250);
    expect(err.name).toBe("TruncatedChangesError");
    expect(err.message).toContain("400");
    expect(err.message).toContain("250");
    expect(err).toBeInstanceOf(Error);
  });

  test("exposes totalSize and returnedSize", () => {
    const err = new TruncatedChangesError(1000, 250);
    expect(err.totalSize).toBe(1000);
    expect(err.returnedSize).toBe(250);
  });
});

describe("validateScopeKey (via resolveScope)", () => {
  function makeCallTool(
    responses: Record<string, unknown> = {},
  ): (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown> {
    return async (_server, tool, _args) => responses[tool] ?? null;
  }

  test("rejects keys with double-quotes (CQL injection)", async () => {
    const provider = createConfluenceProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: '"OR 1=1--' })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with spaces", async () => {
    const provider = createConfluenceProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "FOO BAR" })).rejects.toThrow("Invalid scope key");
  });

  test("rejects keys with semicolons", async () => {
    const provider = createConfluenceProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "FOO; DROP TABLE pages" })).rejects.toThrow("Invalid scope key");
  });

  test("accepts alphanumeric keys", async () => {
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getAccessibleAtlassianResources") {
          return wrapMcpResult([{ id: "cloud-1", url: "https://example.atlassian.net", name: "Example", scopes: [] }]);
        }
        if (tool === "getConfluenceSpaces") {
          return wrapMcpResult({
            results: [{ id: "space-1", key: "VALID", name: "Valid Space", type: "global", status: "current" }],
            _links: { base: "https://example.atlassian.net/wiki" },
          });
        }
        return null;
      },
    });
    // Should not throw
    const resolved = await provider.resolveScope({ key: "VALID123" });
    expect(resolved.key).toBe("VALID123");
  });

  test("accepts keys with hyphens and underscores", async () => {
    const provider = createConfluenceProvider({ callTool: makeCallTool() });
    await expect(provider.resolveScope({ key: "my-space_key" })).rejects.toThrow();
    // The error should not be "Invalid scope key" — it should proceed past validation
    // and fail because the MCP call returns null
    // Actually the callTool returns null for everything so it will fail at the API call, not validation
  });
});

describe("toPath", () => {
  test("leaf page with no children returns <title>.md", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry({ id: "p1", title: "My Page" });
    const result = provider.toPath(entry, [entry]);
    expect(result).toBe("My Page.md");
  });

  test("page with children returns <title>/_index.md", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const parent = makeEntry({ id: "parent", title: "Parent Page" });
    const child = makeEntry({ id: "child", title: "Child Page", parentId: "parent" });
    const result = provider.toPath(parent, [parent, child]);
    expect(result).toBe("Parent Page/_index.md");
  });

  test("child page builds full hierarchy path", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const parent = makeEntry({ id: "parent", title: "Parent" });
    const child = makeEntry({ id: "child", title: "Child", parentId: "parent" });
    const result = provider.toPath(child, [parent, child]);
    expect(result).toBe("Parent/Child.md");
  });

  test("deeply nested page builds full path", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const root = makeEntry({ id: "root", title: "Root" });
    const mid = makeEntry({ id: "mid", title: "Middle", parentId: "root" });
    const leaf = makeEntry({ id: "leaf", title: "Leaf", parentId: "mid" });
    const result = provider.toPath(leaf, [root, mid, leaf]);
    expect(result).toBe("Root/Middle/Leaf.md");
  });

  test("disambiguates siblings with same sanitized title", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const p1 = makeEntry({ id: "page-1", title: "My Page" });
    const p2 = makeEntry({ id: "page-2", title: "My Page" }); // same title, different ID
    const result1 = provider.toPath(p1, [p1, p2]);
    const result2 = provider.toPath(p2, [p1, p2]);
    expect(result1).toBe("My Page-page-1.md");
    expect(result2).toBe("My Page-page-2.md");
  });

  test("sanitizes filesystem-unsafe characters in titles", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const entry = makeEntry({ id: "p1", title: 'Page: "Hello" <World>' });
    const result = provider.toPath(entry, [entry]);
    expect(result).not.toContain(":");
    expect(result).not.toContain('"');
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).toMatch(/\.md$/);
  });

  test("detects cycle in parent chain without infinite loop", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    // p1 → p2 → p1 (cycle)
    const p1 = makeEntry({ id: "p1", title: "P1", parentId: "p2" });
    const p2 = makeEntry({ id: "p2", title: "P2", parentId: "p1" });
    // Should not throw or hang
    expect(() => provider.toPath(p1, [p1, p2])).not.toThrow();
  });
});

describe("frontmatter", () => {
  test("returns expected fields including url", () => {
    const provider = createConfluenceProvider({ callTool: async () => null });
    const scope = makeScope();
    const entry = makeEntry({ id: "page-1", title: "Test", version: 3, lastModified: "2026-01-01T00:00:00Z" });
    const fm = provider.frontmatter(entry, scope);
    expect(fm.id).toBe("page-1");
    expect(fm.version).toBe(3);
    expect(fm.space).toBe("TEST");
    expect(fm.title).toBe("Test");
    expect(typeof fm.url).toBe("string");
    expect(fm.url as string).toContain("page-1");
  });
});

describe("changes — truncation detection", () => {
  test("throws TruncatedChangesError when totalSize exceeds returned results", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "searchConfluenceUsingCql") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [{ content: { id: "p1" }, lastModified: "2026-01-01T00:00:00Z" }],
                  totalSize: 500, // 500 total but only 1 returned
                }),
              },
            ],
          };
        }
        return null;
      },
    });

    const changesMethod = provider.changes as NonNullable<typeof provider.changes>;
    expect(changesMethod).toBeDefined();
    const iter = changesMethod(scope, "2026-01-01T00:00:00Z");
    await expect(async () => {
      for await (const _ of iter) {
        // consume
      }
    }).toThrow(TruncatedChangesError);
  });

  test("yields changes when totalSize <= results.length", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "searchConfluenceUsingCql") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [{ content: { id: "p1" }, lastModified: "2026-01-01T00:00:00Z" }],
                  totalSize: 1, // matches results.length
                }),
              },
            ],
          };
        }
        if (tool === "getConfluencePage") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: "p1",
                  title: "Page 1",
                  status: "current",
                  spaceId: "space-456",
                  createdAt: "2026-01-01T00:00:00Z",
                  version: { number: 1, createdAt: "2026-01-01T00:00:00Z" },
                  body: "# Page 1\n\nContent here.",
                }),
              },
            ],
          };
        }
        return null;
      },
    });

    const changesIter = provider.changes as NonNullable<typeof provider.changes>;
    expect(changesIter).toBeDefined();
    const changes: unknown[] = [];
    for await (const change of changesIter(scope, "2026-01-01T00:00:00Z")) {
      changes.push(change);
    }
    expect(changes).toHaveLength(1);
  });
});

function makePageResponse(id: string, title: string, version = 1) {
  return {
    id,
    title,
    status: "current",
    spaceId: "space-456",
    createdAt: "2026-01-01T00:00:00Z",
    version: { number: version, createdAt: "2026-01-01T00:00:00Z" },
    body: `# ${title}\n\nContent.`,
  };
}

function wrapMcpResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function wrapMcpError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

describe("list", () => {
  test("yields all pages from a single page response", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getPagesInConfluenceSpace") {
          return wrapMcpResult({
            results: [makePageResponse("p1", "Page 1"), makePageResponse("p2", "Page 2")],
          });
        }
        return null;
      },
    });

    const entries: unknown[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
  });

  test("paginates via cursor from _links.next", async () => {
    const scope = makeScope();
    let callCount = 0;
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, args) => {
        if (tool === "getPagesInConfluenceSpace") {
          callCount++;
          if (callCount === 1) {
            return wrapMcpResult({
              results: [makePageResponse("p1", "Page 1")],
              _links: { next: "/pages?cursor=abc123&limit=250" },
            });
          }
          // Second call (with cursor) returns final page
          expect((args as Record<string, unknown>).cursor).toBe("abc123");
          return wrapMcpResult({ results: [makePageResponse("p2", "Page 2")] });
        }
        return null;
      },
    });

    const entries: unknown[] = [];
    for await (const entry of provider.list(scope)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});

/**
 * Every test here runs the retry configuration production actually produces:
 * `maxRetries` is left at its default of 4 (what `resolveProvider` yields, since
 * it passes only `onRetry`). Only the backoff *delays* are shortened, which
 * changes timing and nothing else about the control flow.
 *
 * Do not add `maxRetries: 0` to these tests. That configuration has no caller,
 * and pinning it is exactly what let the shrink-retry path ship inert: with zero
 * retries the in-flight rate-limit loop never runs, so the tests observed a
 * shrink that production never performed (#2950).
 */
const PROD_RETRY = { baseDelayMs: 1, maxDelayMs: 2 } as const;

describe("list — adaptive batch size", () => {
  /**
   * Limits observed by the most recent `drain`. Kept outside the return value so
   * the wire history is still assertable when `list()` throws — which is the
   * interesting case for a sustained rate limit.
   */
  let observedLimits: number[] = [];

  /** Drain list() while recording the `limit` sent on each underlying request. */
  async function drain(
    respond: (call: number, args: Record<string, unknown>) => unknown,
    providerOpts: Partial<Parameters<typeof createConfluenceProvider>[0]> = {},
  ): Promise<{ limits: number[]; cursors: (string | undefined)[]; entries: unknown[] }> {
    const limits: number[] = [];
    observedLimits = limits;
    const cursors: (string | undefined)[] = [];
    let call = 0;
    const provider = createConfluenceProvider({
      ...providerOpts,
      callTool: async (_server, tool, args) => {
        if (tool !== "getPagesInConfluenceSpace") return null;
        call++;
        limits.push((args as Record<string, unknown>).limit as number);
        cursors.push((args as Record<string, unknown>).cursor as string | undefined);
        return respond(call, args as Record<string, unknown>);
      },
    });

    const entries: unknown[] = [];
    for await (const entry of provider.list(makeScope())) {
      entries.push(entry);
    }
    return { limits, cursors, entries };
  }

  test("defaults to a 250-item page limit", async () => {
    const { limits } = await drain(() => wrapMcpResult({ results: [makePageResponse("p1", "Page 1")] }));
    expect(limits).toEqual([250]);
  });

  test("honors an explicit batchSize override", async () => {
    const { limits } = await drain(() => wrapMcpResult({ results: [makePageResponse("p1", "Page 1")] }), {
      batchSize: 50,
    });
    expect(limits).toEqual([50]);
  });

  test("halves the batch size and retries after a rate-limited request", async () => {
    const { limits, entries } = await drain(
      (call) => {
        if (call === 1) throw new Error("429 Too Many Requests");
        return wrapMcpResult({ results: [makePageResponse("p1", "Page 1")] });
      },
      { retry: PROD_RETRY },
    );
    expect(limits).toEqual([250, 125]);
    expect(entries).toHaveLength(1);
  });

  test("every retry under a sustained rate limit goes out smaller", async () => {
    const retried: Array<{ attempt: number; delayMs: number }> = [];
    await expect(
      drain(
        (_call, args) => {
          // Fail every request regardless of size, so the only thing under test is
          // what the loop puts on the wire attempt after attempt.
          throw new Error(`429 Too Many Requests (limit=${args.limit})`);
        },
        { retry: { ...PROD_RETRY, onRetry: (attempt, delayMs) => retried.push({ attempt, delayMs }) } },
      ),
    ).rejects.toThrow(/429/);

    // This is the assertion the feature exists for: at the *default* maxRetries of
    // 4, five requests go out and each one is strictly smaller than the last.
    // Before #2950's fix this read [250, 250, 250, 250, 250].
    expect(observedLimits).toEqual([250, 125, 62, 31, 25]);
    expect(retried.map((r) => r.attempt)).toEqual([1, 2, 3, 4]);
    // Backoff is actually spent between attempts — never a bare hot retry.
    expect(retried.every((r) => r.delayMs > 0)).toBe(true);
  });

  test("reuses the cursor when shrinking, so no items are skipped", async () => {
    const { limits, cursors, entries } = await drain(
      (call) => {
        if (call === 1) {
          return wrapMcpResult({
            results: [makePageResponse("p1", "Page 1")],
            _links: { next: "/pages?cursor=abc123&limit=250" },
          });
        }
        if (call === 2) throw new Error("429 Too Many Requests");
        return wrapMcpResult({ results: [makePageResponse("p2", "Page 2")] });
      },
      { retry: PROD_RETRY },
    );
    expect(limits).toEqual([250, 250, 125]);
    expect(cursors).toEqual([undefined, "abc123", "abc123"]);
    expect(entries).toHaveLength(2);
  });

  test("propagates the rate-limit error once retries are exhausted at the floor", async () => {
    await expect(
      drain(
        () => {
          throw new Error("429 Too Many Requests");
        },
        { batchSize: 50, retry: PROD_RETRY },
      ),
    ).rejects.toThrow(/429/);
    // Floor for a ceiling of 50 is 25; the last two attempts sit on the floor.
    expect(observedLimits).toEqual([50, 25, 25, 25, 25]);
  });

  test("a sub-floor ceiling still adapts instead of silently giving up", async () => {
    await expect(
      drain(
        () => {
          throw new Error("429 Too Many Requests");
        },
        { batchSize: 10, retry: PROD_RETRY },
      ),
    ).rejects.toThrow(/429/);
    // Floor is capped at half the ceiling, so --batch-size 10 shrinks 10 → 5
    // rather than reporting "already at the floor" on the first 429.
    expect(observedLimits).toEqual([10, 5, 5, 5, 5]);
  });

  test("grows back toward the maximum after a run of fast successes", async () => {
    const { limits } = await drain(
      (call) => {
        if (call === 1) throw new Error("429 Too Many Requests");
        const last = call >= 6;
        return wrapMcpResult({
          results: [makePageResponse(`p${call}`, `Page ${call}`)],
          ...(last ? {} : { _links: { next: `/pages?cursor=c${call}&limit=250` } }),
        });
      },
      { retry: PROD_RETRY },
    );

    // 250 rate-limited → 125; three fast successes at 125 grow to ceil(125*1.5)=188.
    expect(limits.slice(0, 5)).toEqual([250, 125, 125, 125, 188]);
  });

  test("non-pagination rate limits leave the pagination batch size alone", async () => {
    // A 429 storm on single-page fetches used to shrink the shared sizer via the
    // resilient caller's onRetry hook, pinning the listing batch near the floor
    // with no path back (nothing but pagination reports success).
    const limits: number[] = [];
    let fetchCalls = 0;
    const provider = createConfluenceProvider({
      retry: PROD_RETRY,
      callTool: async (_server, tool, args) => {
        if (tool === "getConfluencePage") {
          fetchCalls++;
          if (fetchCalls <= 3) throw new Error("429 Too Many Requests");
          return wrapMcpResult(makePageResponse("p1", "Page 1"));
        }
        if (tool !== "getPagesInConfluenceSpace") return null;
        limits.push((args as Record<string, unknown>).limit as number);
        return wrapMcpResult({ results: [makePageResponse("p1", "Page 1")] });
      },
    });

    const scope = makeScope();
    await provider.fetch(scope, "p1");
    for await (const _entry of provider.list(scope)) {
      // drain
    }
    expect(fetchCalls).toBe(4); // three 429s, retried by the resilient caller
    expect(limits).toEqual([250]); // pagination untouched by the fetch storm
  });

  test("no items are skipped or duplicated when the batch shrinks mid-listing", async () => {
    // Mock a real cursor: it encodes an offset into a corpus and honors `limit`.
    // A mock that ignores `limit` can only prove the same cursor string was
    // re-sent — not that the returned window is gap-free and overlap-free.
    const corpus = Array.from({ length: 400 }, (_, i) => `p${i}`);
    let call = 0;
    const limits: number[] = [];
    const provider = createConfluenceProvider({
      retry: PROD_RETRY,
      callTool: async (_server, tool, rawArgs) => {
        if (tool !== "getPagesInConfluenceSpace") return null;
        const args = rawArgs as Record<string, unknown>;
        const limit = args.limit as number;
        const offset = args.cursor ? Number(args.cursor) : 0;
        call++;
        limits.push(limit);
        // Rate-limit a few requests mid-corpus to force shrinks at nonzero offsets.
        if (call === 2 || call === 3 || call === 6) throw new Error("429 Too Many Requests");
        const slice = corpus.slice(offset, offset + limit);
        const nextOffset = offset + slice.length;
        return wrapMcpResult({
          results: slice.map((id) => makePageResponse(id, `Page ${id}`)),
          ...(nextOffset < corpus.length ? { _links: { next: `/pages?cursor=${nextOffset}&limit=${limit}` } } : {}),
        });
      },
    });

    const ids: string[] = [];
    for await (const entry of provider.list(makeScope())) {
      ids.push((entry as RemoteEntry).id);
    }

    expect(ids).toEqual(corpus); // no gaps, no duplicates, original order
    expect(new Set(ids).size).toBe(corpus.length);
    // And the shrinks really happened against the honored limit.
    expect(limits.slice(0, 4)).toEqual([250, 250, 125, 62]);
  });
});

describe("fetch", () => {
  test("fetches a single page by ID", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getConfluencePage") {
          return wrapMcpResult(makePageResponse("p1", "My Page", 3));
        }
        return null;
      },
    });

    const result = await provider.fetch(scope, "p1");
    expect(result.entry.id).toBe("p1");
    expect(result.entry.title).toBe("My Page");
    expect(result.entry.version).toBe(3);
    expect(result.content).toContain("My Page");
  });
});

describe("push", () => {
  test("returns ok: true with new version on success", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "updateConfluencePage") {
          return wrapMcpResult(makePageResponse("p1", "My Page", 4));
        }
        return null;
      },
    });

    const pushFn = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn(scope, "p1", "Updated content", 3);
    expect(result.ok).toBe(true);
    expect(result.newVersion).toBe(4);
  });

  test("returns ok: false with conflict error on 409", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async () => {
        throw new Error("409 Conflict: version mismatch");
      },
    });

    const pushFn2 = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn2(scope, "p1", "Updated content", 3);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("conflict");
  });

  test("returns ok: false with error message on other errors", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async () => {
        throw new Error("Internal server error");
      },
      disableToolDiscovery: true,
    });

    const pushFn3 = provider.push as NonNullable<typeof provider.push>;
    const result = await pushFn3(scope, "p1", "Content", 1);
    expect(result.ok).toBe(false);
    // Error message now includes page URL context and friendly wrapping
    expect(result.error).toContain("example.com/pages/p1");
  });
});

describe("create", () => {
  test("creates a new page and returns the entry", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "createConfluencePage") {
          return wrapMcpResult(makePageResponse("new-id", "New Page", 1));
        }
        return null;
      },
    });

    const createFn = provider.create as NonNullable<typeof provider.create>;
    const entry = await createFn(scope, "parent-id", "New Page", "Content here");
    expect(entry.id).toBe("new-id");
    expect(entry.title).toBe("New Page");
    expect(entry.version).toBe(1);
  });
});

describe("delete", () => {
  test("uses deleteConfluencePage when available", async () => {
    const scope = makeScope();
    const calls: string[] = [];
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        calls.push(tool);
        if (tool === "deleteConfluencePage") {
          return wrapMcpResult({ status: "ok" });
        }
        return null;
      },
    });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await deleteFn(scope, "p1");
    expect(calls).toEqual(["deleteConfluencePage"]);
  });

  test("falls back to status=trashed when deleteConfluencePage is not found", async () => {
    const scope = makeScope();
    const calls: string[] = [];
    const provider = createConfluenceProvider({
      disableToolDiscovery: true,
      callTool: async (_server, tool, _args) => {
        calls.push(tool);
        if (tool === "deleteConfluencePage") {
          throw new Error("Unknown tool: deleteConfluencePage");
        }
        if (tool === "getConfluencePage") {
          return wrapMcpResult(makePageResponse("p1", "My Page", 2));
        }
        if (tool === "updateConfluencePage") {
          return wrapMcpResult(makePageResponse("p1", "My Page", 3));
        }
        return null;
      },
    });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await deleteFn(scope, "p1");
    expect(calls).toContain("deleteConfluencePage");
    expect(calls).toContain("getConfluencePage");
    expect(calls).toContain("updateConfluencePage");
  });

  test("throws when deleteConfluencePage fails with non-tool-not-found error", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      disableToolDiscovery: true,
      callTool: async (_server, tool) => {
        if (tool === "deleteConfluencePage") {
          throw new Error("Permission denied");
        }
        return null;
      },
    });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await expect(deleteFn(scope, "p1")).rejects.toThrow("Failed to delete page p1");
  });

  test("throws when fallback also fails", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool) => {
        if (tool === "deleteConfluencePage") {
          throw new Error("Unknown tool: deleteConfluencePage");
        }
        throw new Error("Server error");
      },
    });

    const deleteFn = provider.delete as NonNullable<typeof provider.delete>;
    await expect(deleteFn(scope, "p1")).rejects.toThrow("Failed to delete page p1");
  });
});

describe("bulkFetchPages", () => {
  test("fetches all pages with inline content and returns entries + contentMap", async () => {
    const scope = makeScope();
    const opts = {
      callTool: async (_server: string, tool: string, _args: Record<string, unknown>) => {
        if (tool === "getPagesInConfluenceSpace") {
          return wrapMcpResult({
            results: [makePageResponse("p1", "Page 1"), makePageResponse("p2", "Page 2")],
          });
        }
        return null;
      },
    };

    const { entries, contentMap } = await bulkFetchPages(opts, scope);
    expect(entries).toHaveLength(2);
    expect(contentMap.has("p1")).toBe(true);
    expect(contentMap.has("p2")).toBe(true);
  });

  test("calls onProgress with count and page data", async () => {
    const scope = makeScope();
    const progressCalls: number[] = [];
    const opts = {
      callTool: async (_server: string, tool: string, _args: Record<string, unknown>) => {
        if (tool === "getPagesInConfluenceSpace") {
          return wrapMcpResult({ results: [makePageResponse("p1", "Page 1")] });
        }
        return null;
      },
    };

    await bulkFetchPages(opts, scope, (count) => {
      progressCalls.push(count);
    });

    expect(progressCalls).toContain(1);
  });

  test("honors batchSize and halves it after a rate-limited request", async () => {
    const scope = makeScope();
    const limits: number[] = [];
    let call = 0;
    const opts = {
      batchSize: 100,
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool !== "getPagesInConfluenceSpace") return null;
        call++;
        limits.push(args.limit as number);
        if (call === 1) throw new Error("429 Too Many Requests");
        return wrapMcpResult({ results: [makePageResponse("p1", "Page 1")] });
      },
    };

    const { entries } = await bulkFetchPages(opts, scope);
    expect(limits).toEqual([100, 50]);
    expect(entries).toHaveLength(1);
  });
});

describe("unwrapToolResult — isError handling", () => {
  test("throws on MCP error response during resolveScope", async () => {
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getAccessibleAtlassianResources") {
          return wrapMcpError("Rate limit exceeded");
        }
        return null;
      },
    });

    await expect(provider.resolveScope({ key: "TEST" })).rejects.toThrow("Rate limit exceeded");
  });

  test("throws on isError during list", async () => {
    const scope = makeScope();
    const provider = createConfluenceProvider({
      callTool: async (_server, tool, _args) => {
        if (tool === "getPagesInConfluenceSpace") {
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
    }).toThrow("403 Forbidden");
  });
});
