import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryResponse } from "./client";
import { _setCacheDir, listRegistry, searchRegistry } from "./client";

const testCacheDir = mkdtempSync(join(tmpdir(), "mcp-cache-test-"));

const MOCK_RESPONSE: RegistryResponse = {
  servers: [
    {
      server: {
        name: "test-server",
        title: "Test Server",
        description: "A test server",
        version: "1.0.0",
      },
      _meta: {
        "com.anthropic.api/mcp-registry": {
          slug: "test-server",
          displayName: "Test Server",
          oneLiner: "A test server for testing",
          isAuthless: true,
        },
      },
    },
  ],
  metadata: { count: 1 },
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _setCacheDir(testCacheDir);
  // Clean cache dir between tests
  for (const f of readdirSync(testCacheDir)) {
    rmSync(join(testCacheDir, f), { force: true });
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setCacheDir(null);
});

afterAll(() => {
  rmSync(testCacheDir, { recursive: true, force: true });
});

describe("searchRegistry", () => {
  test("sends correct query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await searchRegistry("sentry", { noCache: true });

    expect(capturedUrl).toContain("search=sentry");
    expect(capturedUrl).toContain("version=latest");
    expect(capturedUrl).toContain("visibility=commercial");
  });

  test("passes limit and cursor", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await searchRegistry("test", { limit: 5, cursor: "abc123", noCache: true });

    expect(capturedUrl).toContain("limit=5");
    expect(capturedUrl).toContain("cursor=abc123");
  });

  test("throws on non-ok response with status code", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(searchRegistry("missing", { noCache: true })).rejects.toThrow("MCP registry returned 404");
  });

  test("wraps network TypeError with friendly message", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(searchRegistry("test", { noCache: true })).rejects.toThrow(
      "Failed to reach the MCP registry. Check your network connection.",
    );
  });

  test("rethrows non-TypeError errors", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("some other error");
    }) as unknown as typeof fetch;

    await expect(searchRegistry("test", { noCache: true })).rejects.toThrow("some other error");
  });
});

describe("listRegistry", () => {
  test("sends correct params without search query", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await listRegistry({ limit: 10, noCache: true });

    expect(capturedUrl).not.toContain("search=");
    expect(capturedUrl).toContain("version=latest");
    expect(capturedUrl).toContain("visibility=commercial");
    expect(capturedUrl).toContain("limit=10");
  });

  test("passes cursor parameter", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await listRegistry({ cursor: "page2", noCache: true });

    expect(capturedUrl).toContain("cursor=page2");
  });
});

describe("registry cache", () => {
  test("serves cached response on second call", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await searchRegistry("cached-test");
    expect(fetchCount).toBe(1);
    expect(first.servers).toHaveLength(1);

    const second = await searchRegistry("cached-test");
    expect(fetchCount).toBe(1); // no second fetch
    expect(second).toEqual(first);
  });

  test("noCache bypasses cache", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await searchRegistry("bypass-test");
    expect(fetchCount).toBe(1);

    await searchRegistry("bypass-test", { noCache: true });
    expect(fetchCount).toBe(2);
  });

  test("serves stale cache on network error", async () => {
    // Pre-populate a stale cache entry (timestamp 2 hours ago)
    const url =
      "https://api.anthropic.com/mcp-registry/v0/servers?search=stale-test&version=latest&visibility=commercial";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(url);
    const key = hasher.digest("hex").slice(0, 16);

    mkdirSync(testCacheDir, { recursive: true });
    const staleEntry = { timestamp: Date.now() - 2 * 60 * 60 * 1000, data: MOCK_RESPONSE };
    writeFileSync(join(testCacheDir, `${key}.json`), JSON.stringify(staleEntry));

    // Mock fetch to fail
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    // Should return stale cache instead of throwing
    const result = await searchRegistry("stale-test");
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].server.name).toBe("test-server");
  });

  test("throws when offline with no cache", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(searchRegistry("no-cache-offline")).rejects.toThrow(
      "Failed to reach the MCP registry. Check your network connection.",
    );
  });

  test("writes cache files to disk", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await searchRegistry("disk-test");

    const files = readdirSync(testCacheDir);
    expect(files.length).toBe(1);
    expect(files[0]).toEndWith(".json");
  });
});
