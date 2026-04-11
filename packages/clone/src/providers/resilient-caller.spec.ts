import { describe, expect, test } from "bun:test";
import type { McpToolCaller } from "./provider";
import { VfsError, classifyError, createResilientCaller, friendlyMessage } from "./resilient-caller";

describe("classifyError", () => {
  test("detects auth errors", () => {
    expect(classifyError("401 Unauthorized")).toBe("auth");
    expect(classifyError("403 Forbidden")).toBe("auth");
    expect(classifyError("Not authenticated")).toBe("auth");
    expect(classifyError("Token expired")).toBe("auth");
  });

  test("detects rate limit errors", () => {
    expect(classifyError("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyError("rate limit exceeded")).toBe("rate_limit");
    expect(classifyError("too many requests")).toBe("rate_limit");
  });

  test("detects network errors", () => {
    expect(classifyError("ECONNREFUSED")).toBe("network");
    expect(classifyError("ETIMEDOUT")).toBe("network");
    expect(classifyError("fetch failed")).toBe("network");
    expect(classifyError("socket hang up")).toBe("network");
  });

  test("detects not-found errors", () => {
    expect(classifyError("404 Not Found")).toBe("not_found");
    expect(classifyError("unknown tool")).toBe("not_found");
  });

  test("detects conflict errors", () => {
    expect(classifyError("409 Conflict")).toBe("conflict");
    expect(classifyError("version mismatch")).toBe("conflict");
  });

  test("defaults to api for unknown errors", () => {
    expect(classifyError("something went wrong")).toBe("api");
    expect(classifyError("internal server error")).toBe("api");
  });
});

describe("friendlyMessage", () => {
  test("auth error includes credential guidance", () => {
    const err = new VfsError("auth", "401 Unauthorized");
    const msg = friendlyMessage(err);
    expect(msg).toContain("Authentication failed");
    expect(msg).toContain("mcx auth");
  });

  test("rate_limit error suggests waiting", () => {
    const err = new VfsError("rate_limit", "429");
    const msg = friendlyMessage(err);
    expect(msg).toContain("Rate limited");
  });

  test("network error suggests checking connection", () => {
    const err = new VfsError("network", "ECONNREFUSED");
    const msg = friendlyMessage(err);
    expect(msg).toContain("Network error");
    expect(msg).toContain("mcx status");
  });

  test("includes context when provided", () => {
    const err = new VfsError("api", "bad request");
    const msg = friendlyMessage(err, "clone confluence/FOO");
    expect(msg).toContain("clone confluence/FOO");
  });
});

describe("VfsError", () => {
  test("has correct name, kind, and message", () => {
    const cause = new Error("original");
    const err = new VfsError("auth", "Token expired", cause);
    expect(err.name).toBe("VfsError");
    expect(err.kind).toBe("auth");
    expect(err.message).toBe("Token expired");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("createResilientCaller", () => {
  test("passes through successful calls", async () => {
    const caller = createResilientCaller({
      callTool: async () => "ok",
      toolDiscovery: false,
    });
    const result = await caller("server", "tool", {});
    expect(result).toBe("ok");
  });

  test("retries on rate-limit errors with backoff", async () => {
    let attempts = 0;
    const retries: number[] = [];

    const caller = createResilientCaller({
      callTool: async () => {
        attempts++;
        if (attempts <= 2) throw new Error("429 Too Many Requests");
        return "ok";
      },
      maxRetries: 4,
      baseDelayMs: 10, // Fast for tests
      maxDelayMs: 50,
      onRetry: (attempt, delayMs) => retries.push(attempt),
      toolDiscovery: false,
    });

    const result = await caller("server", "tool", {});
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(retries).toHaveLength(2);
  });

  test("throws VfsError after exhausting retries on rate limit", async () => {
    const caller = createResilientCaller({
      callTool: async () => {
        throw new Error("429 Too Many Requests");
      },
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
      toolDiscovery: false,
    });

    try {
      await caller("server", "tool", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VfsError);
      expect((err as VfsError).kind).toBe("rate_limit");
    }
  });

  test("does not retry non-rate-limit errors", async () => {
    let attempts = 0;
    const caller = createResilientCaller({
      callTool: async () => {
        attempts++;
        throw new Error("401 Unauthorized");
      },
      maxRetries: 4,
      baseDelayMs: 10,
      toolDiscovery: false,
    });

    try {
      await caller("server", "tool", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VfsError);
      expect((err as VfsError).kind).toBe("auth");
    }
    expect(attempts).toBe(1); // No retries
  });

  test("tool discovery tries aliases when primary name fails", async () => {
    const triedTools: string[] = [];

    const caller = createResilientCaller({
      callTool: async (_server, tool) => {
        triedTools.push(tool);
        if (tool === "getConfluenceSpaces") {
          throw new Error("unknown tool: getConfluenceSpaces");
        }
        if (tool === "get_confluence_spaces") {
          return "found-via-alias";
        }
        throw new Error(`unknown tool: ${tool}`);
      },
      toolDiscovery: true,
      baseDelayMs: 10,
    });

    const result = await caller("atlassian", "getConfluenceSpaces", {});
    expect(result).toBe("found-via-alias");
    expect(triedTools).toContain("getConfluenceSpaces");
    expect(triedTools).toContain("get_confluence_spaces");
  });

  test("tool discovery caches resolved name for subsequent calls", async () => {
    let callCount = 0;
    const triedTools: string[] = [];

    const caller = createResilientCaller({
      callTool: async (_server, tool) => {
        triedTools.push(tool);
        callCount++;
        if (tool === "getConfluenceSpaces") {
          throw new Error("unknown tool");
        }
        return "ok";
      },
      toolDiscovery: true,
      baseDelayMs: 10,
    });

    // First call: discovers alias
    await caller("atlassian", "getConfluenceSpaces", {});
    const firstCallCount = callCount;

    // Second call: should use cached alias directly
    triedTools.length = 0;
    await caller("atlassian", "getConfluenceSpaces", {});
    // Should only have tried the cached alias, not the canonical name
    expect(callCount - firstCallCount).toBe(1);
    expect(triedTools).not.toContain("getConfluenceSpaces");
  });

  test("tool discovery throws descriptive error when all aliases fail", async () => {
    const caller = createResilientCaller({
      callTool: async (_server, tool) => {
        throw new Error(`unknown tool: ${tool}`);
      },
      toolDiscovery: true,
      baseDelayMs: 10,
    });

    try {
      await caller("atlassian", "getConfluenceSpaces", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VfsError);
      const vfsErr = err as VfsError;
      expect(vfsErr.kind).toBe("not_found");
      expect(vfsErr.message).toContain("Tried aliases");
      expect(vfsErr.message).toContain("mcx ls atlassian");
    }
  });

  test("tool discovery does not try aliases for non-not_found errors", async () => {
    let attempts = 0;
    const caller = createResilientCaller({
      callTool: async () => {
        attempts++;
        throw new Error("401 Unauthorized");
      },
      toolDiscovery: true,
      baseDelayMs: 10,
    });

    try {
      await caller("atlassian", "getConfluenceSpaces", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VfsError);
      expect((err as VfsError).kind).toBe("auth");
    }
    expect(attempts).toBe(1); // Only tried the canonical name
  });

  test("passes timeout through to underlying caller", async () => {
    let receivedTimeout: number | undefined;
    const caller = createResilientCaller({
      callTool: async (_server, _tool, _args, timeoutMs) => {
        receivedTimeout = timeoutMs;
        return "ok";
      },
      toolDiscovery: false,
    });

    await caller("server", "tool", {}, 5000);
    expect(receivedTimeout).toBe(5000);
  });
});
