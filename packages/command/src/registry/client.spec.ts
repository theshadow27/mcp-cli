import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RegistryResponse } from "./client.js";
import { listRegistry, searchRegistry } from "./client.js";

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

describe("searchRegistry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends correct query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await searchRegistry("sentry");

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

    await searchRegistry("test", { limit: 5, cursor: "abc123" });

    expect(capturedUrl).toContain("limit=5");
    expect(capturedUrl).toContain("cursor=abc123");
  });

  test("throws on non-ok response with status code", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(searchRegistry("missing")).rejects.toThrow("MCP registry returned 404");
  });

  test("wraps network TypeError with friendly message", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(searchRegistry("test")).rejects.toThrow(
      "Failed to reach the MCP registry. Check your network connection.",
    );
  });

  test("rethrows non-TypeError errors", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("some other error");
    }) as unknown as typeof fetch;

    await expect(searchRegistry("test")).rejects.toThrow("some other error");
  });
});

describe("listRegistry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends correct params without search query", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await listRegistry({ limit: 10 });

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

    await listRegistry({ cursor: "page2" });

    expect(capturedUrl).toContain("cursor=page2");
  });
});
