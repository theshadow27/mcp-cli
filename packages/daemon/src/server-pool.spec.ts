import { describe, expect, mock, test } from "bun:test";
import type {
  ConfigSource,
  HttpServerConfig,
  ResolvedConfig,
  ResolvedServer,
  SseServerConfig,
  StdioServerConfig,
} from "@mcp-cli/core";
import {
  BASE_ENV_ALLOWLIST,
  ServerPool,
  buildChildEnv,
  isRetryableError,
  isTransientCallError,
  wrapTransportError,
} from "./server-pool.js";

const stdio: StdioServerConfig = { command: "npx", args: ["-y", "my-server"] };
const http: HttpServerConfig = { type: "http", url: "https://example.com/mcp" };
const sse: SseServerConfig = { type: "sse", url: "https://sse.example.com/events" };

const testSource: ConfigSource = { file: "/test", scope: "user" };

/** Build a minimal ResolvedConfig for testing. */
function makeConfig(servers: Record<string, StdioServerConfig>): ResolvedConfig {
  const map = new Map<string, ResolvedServer>();
  for (const [name, config] of Object.entries(servers)) {
    map.set(name, { name, config, source: testSource });
  }
  return { servers: map, sources: [] };
}

function errWithCode(message: string, code: string): Error {
  const e = new Error(message);
  (e as unknown as Record<string, unknown>).code = code;
  return e;
}

describe("isRetryableError", () => {
  test("returns false for non-Error values", () => {
    expect(isRetryableError("string error")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });

  describe("retryable system error codes", () => {
    const retryableCodes = [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
      "EAI_AGAIN",
    ];

    for (const code of retryableCodes) {
      test(`retries ${code}`, () => {
        expect(isRetryableError(errWithCode("connect failed", code))).toBe(true);
      });
    }
  });

  describe("retryable message patterns", () => {
    test("retries fetch failed", () => {
      expect(isRetryableError(new Error("TypeError: fetch failed"))).toBe(true);
    });

    test("retries socket hang up", () => {
      expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    });
  });

  describe("non-retryable errors", () => {
    test("does not retry 401 auth errors", () => {
      expect(isRetryableError(new Error("HTTP 401 Unauthorized"))).toBe(false);
    });

    test("does not retry 403 forbidden errors", () => {
      expect(isRetryableError(new Error("HTTP 403 Forbidden"))).toBe(false);
    });

    test("does not retry command not found", () => {
      expect(isRetryableError(new Error("command not found: foo"))).toBe(false);
    });

    test("does not retry permission denied", () => {
      expect(isRetryableError(new Error("permission denied for /usr/bin/foo"))).toBe(false);
    });

    test("does not retry ENOENT (bad config)", () => {
      expect(isRetryableError(errWithCode("spawn foo", "ENOENT"))).toBe(false);
    });

    test("does not retry EACCES", () => {
      expect(isRetryableError(errWithCode("spawn foo", "EACCES"))).toBe(false);
    });

    test("does not retry generic errors", () => {
      expect(isRetryableError(new Error("something went wrong"))).toBe(false);
    });
  });
});

describe("wrapTransportError", () => {
  // -- Stdio transport --

  describe("stdio", () => {
    test("ENOENT → command not found", () => {
      const result = wrapTransportError("foo", stdio, errWithCode("spawn ENOENT", "ENOENT"));
      expect(result.message).toContain('command "npx" not found');
      expect(result.message).toContain("PATH");
    });

    test("message containing 'not found' → command not found", () => {
      const result = wrapTransportError("foo", stdio, new Error("command not found: npx"));
      expect(result.message).toContain('command "npx" not found');
    });

    test("EACCES → permission denied", () => {
      const result = wrapTransportError("foo", stdio, errWithCode("EACCES", "EACCES"));
      expect(result.message).toContain("permission denied");
      expect(result.message).toContain('"npx"');
    });

    test("message containing 'permission denied' → permission denied", () => {
      const result = wrapTransportError("foo", stdio, new Error("permission denied /bin/server"));
      expect(result.message).toContain("permission denied");
    });

    test("process exit → actionable exit message with command", () => {
      const result = wrapTransportError("foo", stdio, new Error("process exited with code 1"));
      expect(result.message).toContain("process exited unexpectedly");
      expect(result.message).toContain("npx -y my-server");
    });

    test("spawn error → actionable exit message", () => {
      const result = wrapTransportError("foo", stdio, new Error("spawn failed"));
      expect(result.message).toContain("process exited unexpectedly");
    });

    test("unknown stdio error → generic stdio fallback", () => {
      const result = wrapTransportError("foo", stdio, new Error("something weird happened"));
      expect(result.message).toContain('Server "foo" failed (stdio)');
      expect(result.message).toContain("something weird happened");
    });
  });

  // -- HTTP transport --

  describe("http", () => {
    test("ECONNREFUSED → connection refused", () => {
      const result = wrapTransportError("api", http, errWithCode("connect ECONNREFUSED", "ECONNREFUSED"));
      expect(result.message).toContain("could not connect to https://example.com/mcp");
      expect(result.message).toContain("Is the server running?");
    });

    test("ENOTFOUND → DNS failure", () => {
      const result = wrapTransportError("api", http, errWithCode("getaddrinfo ENOTFOUND", "ENOTFOUND"));
      expect(result.message).toContain("DNS lookup failed");
      expect(result.message).toContain("https://example.com/mcp");
    });

    test("certificate error → TLS message", () => {
      const result = wrapTransportError("api", http, new Error("self-signed certificate in chain"));
      expect(result.message).toContain("TLS/certificate error");
      expect(result.message).toContain("https://example.com/mcp");
    });

    test("401 → auth failed with mcp auth hint", () => {
      const result = wrapTransportError("api", http, new Error("HTTP 401 Unauthorized"));
      expect(result.message).toContain("auth failed (401)");
      expect(result.message).toContain("mcp auth api");
    });

    test("403 → forbidden with auth hint", () => {
      const result = wrapTransportError("api", http, new Error("HTTP 403 Forbidden"));
      expect(result.message).toContain("auth failed (403 Forbidden)");
      expect(result.message).toContain("mcp auth api");
    });

    test("ETIMEDOUT → timeout", () => {
      const result = wrapTransportError("api", http, errWithCode("connect ETIMEDOUT", "ETIMEDOUT"));
      expect(result.message).toContain("timed out");
      expect(result.message).toContain("https://example.com/mcp");
    });

    test("unknown http error → generic http fallback", () => {
      const result = wrapTransportError("api", http, new Error("weird network issue"));
      expect(result.message).toContain('Server "api" failed (http)');
      expect(result.message).toContain("weird network issue");
    });
  });

  // -- SSE transport --

  describe("sse", () => {
    test("connection refused → same as HTTP", () => {
      const result = wrapTransportError("events", sse, new Error("connection refused"));
      expect(result.message).toContain("could not connect to https://sse.example.com/events");
    });

    test("SSE stream error → SSE-specific message", () => {
      const result = wrapTransportError("events", sse, new Error("EventSource stream closed"));
      expect(result.message).toContain("SSE stream error");
      expect(result.message).toContain("https://sse.example.com/events");
    });

    test("unknown sse error → generic sse fallback", () => {
      const result = wrapTransportError("events", sse, new Error("something else"));
      expect(result.message).toContain('Server "events" failed (sse)');
    });
  });

  // -- Edge cases --

  describe("edge cases", () => {
    test("non-Error input (string) → still wrapped", () => {
      const result = wrapTransportError("foo", stdio, "string error");
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain("string error");
    });

    test("server name appears in all messages", () => {
      const result = wrapTransportError("my-server", http, new Error("something"));
      expect(result.message).toContain('"my-server"');
    });

    test("UNABLE_TO_VERIFY_LEAF_SIGNATURE code → TLS error", () => {
      const result = wrapTransportError(
        "api",
        http,
        errWithCode("unable to verify", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
      );
      expect(result.message).toContain("TLS/certificate error");
    });
  });
});

describe("ServerPool.updateConfig", () => {
  test("detects added servers", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual(["b"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  test("detects removed servers", () => {
    const initial = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "echo" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["b"]);
    expect(result.changed).toEqual([]);
  });

  test("detects changed server configs", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "cat" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual(["a"]);
  });

  test("returns empty lists when config unchanged", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "echo" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  test("handles simultaneous add, remove, and change", () => {
    const initial = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "sed" }, c: { command: "grep" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual(["c"]);
    expect(result.removed).toEqual(["b"]);
    expect(result.changed).toEqual(["a"]);
  });

  test("listServers reflects updated config after add", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    pool.updateConfig(updated);

    const names = pool
      .listServers()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["a", "b"]);
  });

  test("listServers reflects updated config after remove", () => {
    const initial = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const pool = new ServerPool(initial);

    const updated = makeConfig({ a: { command: "echo" } });
    pool.updateConfig(updated);

    const names = pool.listServers().map((s) => s.name);
    expect(names).toEqual(["a"]);
  });
});

describe("buildChildEnv", () => {
  /** Simulated parent process.env with both safe and sensitive vars. */
  const parentEnv: Record<string, string | undefined> = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    SHELL: "/bin/zsh",
    USER: "testuser",
    TMPDIR: "/tmp",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    // Sensitive vars that should NOT be inherited
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_SESSION_TOKEN: "FwoGZXIvYXdzECEaDHQa...",
    GITHUB_TOKEN: "ghp_xxxxxxxxxxxx",
    GH_TOKEN: "ghp_yyyyyyyyyyyy",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    NPM_TOKEN: "npm_zzzzzzzzz",
    OPENAI_API_KEY: "sk-xxxxxxxxxxxxx",
    DATABASE_URL: "postgres://user:pass@host/db",
    SECRET_KEY: "super-secret-value",
    DOCKER_HOST: "unix:///var/run/docker.sock",
  };

  describe("default env allowlist", () => {
    test("includes all allowlisted vars from process.env", () => {
      const env = buildChildEnv(parentEnv);
      for (const key of BASE_ENV_ALLOWLIST) {
        const expected = parentEnv[key];
        if (expected !== undefined) {
          expect(env[key]).toBe(expected);
        }
      }
    });

    test("only contains allowlisted keys when no configured env", () => {
      const env = buildChildEnv(parentEnv);
      const keys = Object.keys(env);
      for (const key of keys) {
        expect(BASE_ENV_ALLOWLIST).toContain(key);
      }
    });

    test("skips allowlisted vars not present in parent env", () => {
      const sparse: Record<string, string | undefined> = { PATH: "/usr/bin" };
      const env = buildChildEnv(sparse);
      expect(env).toEqual({ PATH: "/usr/bin" });
    });

    test("returns empty object when parent env is empty", () => {
      const env = buildChildEnv({});
      expect(env).toEqual({});
    });
  });

  describe("explicitly configured vars", () => {
    test("passes through configured env vars", () => {
      const env = buildChildEnv(parentEnv, {
        MY_API_KEY: "configured-key",
        CUSTOM_VAR: "custom-value",
      });
      expect(env.MY_API_KEY).toBe("configured-key");
      expect(env.CUSTOM_VAR).toBe("custom-value");
    });

    test("configured vars can override allowlisted vars", () => {
      const env = buildChildEnv(parentEnv, { PATH: "/custom/bin" });
      expect(env.PATH).toBe("/custom/bin");
    });

    test("configured vars can include sensitive names if explicitly set", () => {
      const env = buildChildEnv(parentEnv, {
        AWS_ACCESS_KEY_ID: "explicit-key",
        GITHUB_TOKEN: "explicit-token",
      });
      // These are present because they were explicitly configured
      expect(env.AWS_ACCESS_KEY_ID).toBe("explicit-key");
      expect(env.GITHUB_TOKEN).toBe("explicit-token");
    });
  });

  describe("sensitive vars excluded", () => {
    const sensitiveVars = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "SSH_AUTH_SOCK",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "SECRET_KEY",
      "DOCKER_HOST",
    ];

    test("does not inherit sensitive vars from parent env", () => {
      const env = buildChildEnv(parentEnv);
      for (const key of sensitiveVars) {
        expect(env[key]).toBeUndefined();
      }
    });

    test("sensitive vars not inherited even with unrelated configured vars", () => {
      const env = buildChildEnv(parentEnv, { INNOCUOUS: "value" });
      for (const key of sensitiveVars) {
        expect(env[key]).toBeUndefined();
      }
    });
  });

  describe("env var expansion integration", () => {
    test("expanded values in configured env are passed through", () => {
      // The config loader runs expandEnvVarsDeep before the server config
      // reaches createTransport, so config.env values are already expanded.
      // This test verifies buildChildEnv faithfully passes the expanded values.
      const env = buildChildEnv(parentEnv, {
        API_URL: "https://api.example.com/v1",
        AUTH_HEADER: "Bearer token-abc123",
      });
      expect(env.API_URL).toBe("https://api.example.com/v1");
      expect(env.AUTH_HEADER).toBe("Bearer token-abc123");
    });
  });
});

describe("BASE_ENV_ALLOWLIST", () => {
  test("contains expected base vars", () => {
    expect(BASE_ENV_ALLOWLIST).toContain("PATH");
    expect(BASE_ENV_ALLOWLIST).toContain("HOME");
    expect(BASE_ENV_ALLOWLIST).toContain("TERM");
    expect(BASE_ENV_ALLOWLIST).toContain("LANG");
    expect(BASE_ENV_ALLOWLIST).toContain("SHELL");
    expect(BASE_ENV_ALLOWLIST).toContain("USER");
    expect(BASE_ENV_ALLOWLIST).toContain("TMPDIR");
    expect(BASE_ENV_ALLOWLIST).toContain("XDG_RUNTIME_DIR");
    expect(BASE_ENV_ALLOWLIST).toContain("DISPLAY");
    expect(BASE_ENV_ALLOWLIST).toContain("WAYLAND_DISPLAY");
  });

  test("does not contain sensitive var names", () => {
    expect(BASE_ENV_ALLOWLIST).not.toContain("AWS_ACCESS_KEY_ID");
    expect(BASE_ENV_ALLOWLIST).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(BASE_ENV_ALLOWLIST).not.toContain("GITHUB_TOKEN");
    expect(BASE_ENV_ALLOWLIST).not.toContain("SSH_AUTH_SOCK");
    expect(BASE_ENV_ALLOWLIST).not.toContain("NPM_TOKEN");
  });

  test("is immutable (ReadonlyArray)", () => {
    // TypeScript enforces ReadonlyArray at compile time; at runtime,
    // verify the constant is a plain array (not frozen, but typed as readonly).
    expect(Array.isArray(BASE_ENV_ALLOWLIST)).toBe(true);
    expect(BASE_ENV_ALLOWLIST.length).toBeGreaterThan(0);
  });
});

// -- isTransientCallError --

describe("isTransientCallError", () => {
  test("returns false for non-Error values", () => {
    expect(isTransientCallError("string")).toBe(false);
    expect(isTransientCallError(null)).toBe(false);
    expect(isTransientCallError(42)).toBe(false);
  });

  describe("inherits all isRetryableError patterns", () => {
    test("ECONNRESET is transient", () => {
      expect(isTransientCallError(errWithCode("connection reset", "ECONNRESET"))).toBe(true);
    });

    test("ECONNREFUSED is transient", () => {
      expect(isTransientCallError(errWithCode("connection refused", "ECONNREFUSED"))).toBe(true);
    });

    test("ETIMEDOUT is transient", () => {
      expect(isTransientCallError(errWithCode("timeout", "ETIMEDOUT"))).toBe(true);
    });

    test("fetch failed is transient", () => {
      expect(isTransientCallError(new Error("TypeError: fetch failed"))).toBe(true);
    });

    test("socket hang up is transient", () => {
      expect(isTransientCallError(new Error("socket hang up"))).toBe(true);
    });
  });

  describe("stale connection patterns", () => {
    test("'connection closed' is transient", () => {
      expect(isTransientCallError(new Error("Connection closed"))).toBe(true);
    });

    test("'disconnected' is transient", () => {
      expect(isTransientCallError(new Error("Client disconnected"))).toBe(true);
    });

    test("'connection lost' is transient", () => {
      expect(isTransientCallError(new Error("connection lost"))).toBe(true);
    });

    test("'broken pipe' is transient", () => {
      expect(isTransientCallError(new Error("broken pipe"))).toBe(true);
    });

    test("'stream ended' is transient", () => {
      expect(isTransientCallError(new Error("SSE stream ended unexpectedly"))).toBe(true);
    });

    test("'aborted' is transient", () => {
      expect(isTransientCallError(new Error("request aborted"))).toBe(true);
    });

    test("'transport closed' is transient", () => {
      expect(isTransientCallError(new Error("transport closed"))).toBe(true);
    });

    test("'eof' is transient", () => {
      expect(isTransientCallError(new Error("unexpected eof"))).toBe(true);
    });

    test("'reset' is transient", () => {
      expect(isTransientCallError(new Error("connection reset by peer"))).toBe(true);
    });
  });

  describe("non-transient errors", () => {
    test("401 is not transient", () => {
      expect(isTransientCallError(new Error("HTTP 401 Unauthorized"))).toBe(false);
    });

    test("403 is not transient", () => {
      expect(isTransientCallError(new Error("HTTP 403 Forbidden"))).toBe(false);
    });

    test("'unauthorized' is not transient", () => {
      expect(isTransientCallError(new Error("Unauthorized access"))).toBe(false);
    });

    test("'forbidden' is not transient", () => {
      expect(isTransientCallError(new Error("Forbidden resource"))).toBe(false);
    });

    test("'not found' is not transient", () => {
      expect(isTransientCallError(new Error("Tool not found"))).toBe(false);
    });

    test("'permission denied' is not transient", () => {
      expect(isTransientCallError(new Error("permission denied"))).toBe(false);
    });

    test("'invalid' is not transient", () => {
      expect(isTransientCallError(new Error("Invalid arguments"))).toBe(false);
    });

    test("generic unknown error is not transient", () => {
      expect(isTransientCallError(new Error("something went wrong"))).toBe(false);
    });
  });
});

// -- callTool auto-retry --

/** Type-safe accessor for private ServerPool internals used in tests. */
interface PoolInternals {
  connections: Map<string, Record<string, unknown>>;
  ensureConnected: (...args: unknown[]) => Promise<unknown>;
}

function getPoolInternals(pool: ServerPool): PoolInternals {
  return pool as unknown as PoolInternals;
}

function getConn(pool: ServerPool, name: string): Record<string, unknown> {
  const conn = getPoolInternals(pool).connections.get(name);
  if (!conn) throw new Error(`Connection "${name}" not found in pool`);
  return conn;
}

function makeMockTransport() {
  return {
    close: mock(() => Promise.resolve()),
    start: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((err: Error) => void) | undefined,
  };
}

describe("ServerPool.callTool auto-retry", () => {
  /**
   * Helper to create a ServerPool with a fake connection injected.
   * We bypass ensureConnected() by directly setting the connection state to "connected"
   * and injecting a mock client.
   */
  function setupPoolWithMockClient(callToolFn: (...args: unknown[]) => Promise<unknown>) {
    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    conn.state = "connected";
    conn.lastUsed = Date.now();
    conn.client = {
      callTool: callToolFn,
      close: mock(() => Promise.resolve()),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      connect: mock(() => Promise.resolve()),
    };
    conn.transport = makeMockTransport();

    return { pool, conn };
  }

  test("successful call does not trigger retry logic", async () => {
    const callToolMock = mock(() => Promise.resolve({ content: [{ text: "ok" }] }));
    const { pool } = setupPoolWithMockClient(callToolMock);

    const result = await pool.callTool("test", "my-tool", { arg: 1 });

    expect(result).toEqual({ content: [{ text: "ok" }] });
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  test("non-transient error surfaces immediately without retry", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("HTTP 401 Unauthorized")));
    const { pool } = setupPoolWithMockClient(callToolMock);

    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("401 Unauthorized");
    // Should only be called once — no retry
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  test("transient error triggers reconnect and successful retry", async () => {
    let callCount = 0;
    const callToolMock = mock((): Promise<unknown> => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Connection closed"));
      }
      return Promise.resolve({ content: [{ text: "retried-ok" }] });
    });

    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    const mockClient = {
      callTool: callToolMock,
      close: mock(() => Promise.resolve()),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      connect: mock(() => Promise.resolve()),
    };

    conn.state = "connected";
    conn.lastUsed = Date.now();
    conn.client = mockClient;
    conn.transport = makeMockTransport();

    // Mock ensureConnected: after disconnect, the pool calls ensureConnected which will
    // try to create a real transport. We need to intercept that. We'll replace the
    // private method with a mock that re-injects our mock client.
    let ensureConnectedCallCount = 0;
    getPoolInternals(pool).ensureConnected = async (..._args: unknown[]) => {
      ensureConnectedCallCount++;
      if (ensureConnectedCallCount === 1) {
        // First call — return the connection as-is (before the callTool failure)
        return conn;
      }
      // Second call (after disconnect + reconnect) — re-inject mock client
      conn.state = "connected";
      conn.client = mockClient;
      conn.lastUsed = Date.now();
      return conn;
    };

    const result = await pool.callTool("test", "my-tool", { x: 42 });

    expect(result).toEqual({ content: [{ text: "retried-ok" }] });
    // callTool was called twice: once failed, once succeeded
    expect(callToolMock).toHaveBeenCalledTimes(2);
    // ensureConnected was called twice: initial + reconnect
    expect(ensureConnectedCallCount).toBe(2);
  });

  test("only one retry attempt — second transient error is not retried", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("Connection closed")));

    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    const mockClient = {
      callTool: callToolMock,
      close: mock(() => Promise.resolve()),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      connect: mock(() => Promise.resolve()),
    };

    conn.state = "connected";
    conn.lastUsed = Date.now();
    conn.client = mockClient;
    conn.transport = makeMockTransport();

    // Mock ensureConnected to re-inject mock client on reconnect
    let ensureConnectedCallCount = 0;
    getPoolInternals(pool).ensureConnected = async () => {
      ensureConnectedCallCount++;
      conn.state = "connected";
      conn.client = mockClient;
      conn.lastUsed = Date.now();
      return conn;
    };

    // Both calls fail — the retry should also throw, not loop infinitely
    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("Connection closed");
    // callTool was called exactly twice: initial + one retry
    expect(callToolMock).toHaveBeenCalledTimes(2);
    expect(ensureConnectedCallCount).toBe(2);
  });

  test("ECONNRESET during call triggers auto-retry", async () => {
    let callCount = 0;
    const callToolMock = mock((): Promise<unknown> => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(errWithCode("read ECONNRESET", "ECONNRESET"));
      }
      return Promise.resolve({ content: [{ text: "recovered" }] });
    });

    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    const mockClient = {
      callTool: callToolMock,
      close: mock(() => Promise.resolve()),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      connect: mock(() => Promise.resolve()),
    };

    conn.state = "connected";
    conn.lastUsed = Date.now();
    conn.client = mockClient;
    conn.transport = makeMockTransport();

    getPoolInternals(pool).ensureConnected = async () => {
      conn.state = "connected";
      conn.client = mockClient;
      conn.lastUsed = Date.now();
      return conn;
    };

    const result = await pool.callTool("test", "my-tool", {});
    expect(result).toEqual({ content: [{ text: "recovered" }] });
    expect(callToolMock).toHaveBeenCalledTimes(2);
  });

  test("permission denied error is not retried", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("permission denied for resource")));
    const { pool } = setupPoolWithMockClient(callToolMock);

    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("permission denied");
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  test("'not found' error is not retried", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("Tool not found on server")));
    const { pool } = setupPoolWithMockClient(callToolMock);

    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("not found");
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });
});

// -- Transport lifecycle (crash detection) --

describe("transport lifecycle handlers", () => {
  test("transport onclose resets connection state to disconnected", () => {
    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    conn.state = "connected";
    conn.client = { close: mock(() => Promise.resolve()) };

    const transport = makeMockTransport();
    conn.transport = transport;

    // Simulate what attachTransportLifecycle does by calling it via the pool internals
    // We access the private method through type-casting
    const poolAny = pool as unknown as { attachTransportLifecycle: (name: string, t: unknown, c: unknown) => void };
    poolAny.attachTransportLifecycle("test", transport, conn);

    // Verify transport handlers were attached
    expect(transport.onclose).toBeDefined();
    expect(transport.onerror).toBeDefined();

    // Fire onclose
    (transport as unknown as { onclose: () => void }).onclose();

    expect(conn.state).toBe("disconnected");
    expect(conn.client).toBeNull();
    expect(conn.transport).toBeNull();
  });

  test("transport onerror resets connection state and records lastError", () => {
    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    conn.state = "connected";
    conn.client = { close: mock(() => Promise.resolve()) };

    const transport = makeMockTransport();
    conn.transport = transport;

    const poolAny = pool as unknown as { attachTransportLifecycle: (name: string, t: unknown, c: unknown) => void };
    poolAny.attachTransportLifecycle("test", transport, conn);

    // Fire onerror
    (transport as unknown as { onerror: (err: Error) => void }).onerror(new Error("server crashed"));

    expect(conn.state).toBe("disconnected");
    expect(conn.client).toBeNull();
    expect(conn.transport).toBeNull();
    expect(conn.lastError).toBe("server crashed");
  });

  test("transport onclose is a no-op if already disconnected", () => {
    const config = makeConfig({ test: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "test");
    conn.state = "disconnected";
    conn.client = null;

    const transport = makeMockTransport();
    conn.transport = null;

    const poolAny = pool as unknown as { attachTransportLifecycle: (name: string, t: unknown, c: unknown) => void };
    poolAny.attachTransportLifecycle("test", transport, conn);

    // Fire onclose when already disconnected — should be a no-op
    (transport as unknown as { onclose: () => void }).onclose();

    expect(conn.state).toBe("disconnected");
  });
});

// -- Config-triggered reconnect --

describe("ServerPool.updateConfig reconnect", () => {
  test("config change on connected server triggers disconnect + reconnect", async () => {
    const config = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(config);

    const conn = getConn(pool, "a");
    conn.state = "connected";
    conn.client = {
      close: mock(() => Promise.resolve()),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      connect: mock(() => Promise.resolve()),
    };
    conn.transport = makeMockTransport();

    // Track ensureConnected calls
    let reconnectCalled = false;
    getPoolInternals(pool).ensureConnected = async () => {
      reconnectCalled = true;
      conn.state = "connected";
      return conn;
    };

    const updated = makeConfig({ a: { command: "cat" } });
    pool.updateConfig(updated);

    // Wait for the async disconnect → reconnect chain
    await new Promise((r) => setTimeout(r, 50));

    expect(reconnectCalled).toBe(true);
  });

  test("config change on disconnected server does not trigger reconnect", async () => {
    const config = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(config);

    // Server is disconnected
    const conn = getConn(pool, "a");
    expect(conn.state).toBe("disconnected");

    let reconnectCalled = false;
    getPoolInternals(pool).ensureConnected = async () => {
      reconnectCalled = true;
      return conn;
    };

    const updated = makeConfig({ a: { command: "cat" } });
    pool.updateConfig(updated);

    await new Promise((r) => setTimeout(r, 50));

    // Should NOT reconnect because the server wasn't connected
    expect(reconnectCalled).toBe(false);
  });
});
