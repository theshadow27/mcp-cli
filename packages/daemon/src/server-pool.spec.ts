import { describe, expect, mock, test } from "bun:test";
import { MCP_TOOL_TIMEOUT_MS, silentLogger } from "@mcp-cli/core";
import type { HttpServerConfig, SseServerConfig, StdioServerConfig } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  BASE_ENV_ALLOWLIST,
  type ConnectFn,
  ServerPool,
  buildChildEnv,
  isRetryableError,
  isTransientCallError,
  safeStderrWrite,
  wrapTransportError,
} from "./server-pool";
import { makeConfig, makeMockClient, makeMockTransport } from "./test-helpers";

const stdio: StdioServerConfig = { command: "npx", args: ["-y", "my-server"] };
const http: HttpServerConfig = { type: "http", url: "https://example.com/mcp" };
const sse: SseServerConfig = { type: "sse", url: "https://sse.example.com/events" };

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

    test("401 → auth failed with mcx auth hint", () => {
      const result = wrapTransportError("api", http, new Error("HTTP 401 Unauthorized"));
      expect(result.message).toContain("auth failed (401)");
      expect(result.message).toContain("mcx auth api");
    });

    test("403 → forbidden with auth hint", () => {
      const result = wrapTransportError("api", http, new Error("HTTP 403 Forbidden"));
      expect(result.message).toContain("auth failed (403 Forbidden)");
      expect(result.message).toContain("mcx auth api");
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
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

    const updated = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual(["b"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  test("detects removed servers", () => {
    const initial = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

    const updated = makeConfig({ a: { command: "echo" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["b"]);
    expect(result.changed).toEqual([]);
  });

  test("detects changed server configs", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

    const updated = makeConfig({ a: { command: "cat" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual(["a"]);
  });

  test("returns empty lists when config unchanged", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

    const updated = makeConfig({ a: { command: "echo" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  test("handles simultaneous add, remove, and change", () => {
    const initial = makeConfig({ a: { command: "echo" }, b: { command: "cat" } });
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

    const updated = makeConfig({ a: { command: "sed" }, c: { command: "grep" } });
    const result = pool.updateConfig(updated);

    expect(result.added).toEqual(["c"]);
    expect(result.removed).toEqual(["b"]);
    expect(result.changed).toEqual(["a"]);
  });

  test("listServers reflects updated config after add", () => {
    const initial = makeConfig({ a: { command: "echo" } });
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

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
    const pool = new ServerPool(initial, undefined, undefined, silentLogger);

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

/** Create a mock ConnectFn. Returns the connectFn and the transport for lifecycle testing. */
function mockConnectFn(
  overrides?: Parameters<typeof makeMockClient>[0],
  transport?: ReturnType<typeof makeMockTransport>,
): {
  connectFn: ConnectFn;
  transport: ReturnType<typeof makeMockTransport>;
} {
  const t = transport ?? makeMockTransport();
  const client = makeMockClient(overrides);
  const connectFn = mock(() =>
    Promise.resolve({ client: client as unknown as Client, transport: t as unknown as Transport }),
  );
  return { connectFn, transport: t };
}

describe("ServerPool.callTool auto-retry", () => {
  test("successful call does not trigger retry logic", async () => {
    const callToolMock = mock(() => Promise.resolve({ content: [{ text: "ok" }] }));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    const result = await pool.callTool("test", "my-tool", { arg: 1 });

    expect(result).toEqual({ content: [{ text: "ok" }] });
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  test("forwards default MCP_TOOL_TIMEOUT_MS to client.callTool options", async () => {
    const callToolMock = mock((...args: unknown[]) => Promise.resolve({ content: [] }));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await pool.callTool("test", "my-tool", {});

    // Third argument to callTool should contain { timeout: MCP_TOOL_TIMEOUT_MS }
    const opts = callToolMock.mock.calls[0][2] as { timeout?: number };
    expect(opts).toEqual({ timeout: MCP_TOOL_TIMEOUT_MS });
  });

  test("forwards custom timeoutMs to client.callTool options", async () => {
    const callToolMock = mock((...args: unknown[]) => Promise.resolve({ content: [] }));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await pool.callTool("test", "my-tool", {}, 30_000);

    const opts = callToolMock.mock.calls[0][2] as { timeout?: number };
    expect(opts).toEqual({ timeout: 30_000 });
  });

  test("non-transient error surfaces immediately without retry", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("HTTP 401 Unauthorized")));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

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

    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    const result = await pool.callTool("test", "my-tool", { x: 42 });

    expect(result).toEqual({ content: [{ text: "retried-ok" }] });
    expect(callToolMock).toHaveBeenCalledTimes(2);
    // connectFn called twice: initial connect + reconnect after transient error
    expect(connectFn).toHaveBeenCalledTimes(2);
  });

  test("only one retry attempt — second transient error is not retried", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("Connection closed")));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("Connection closed");
    // callTool was called exactly twice: initial + one retry
    expect(callToolMock).toHaveBeenCalledTimes(2);
    expect(connectFn).toHaveBeenCalledTimes(2);
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

    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    const result = await pool.callTool("test", "my-tool", {});
    expect(result).toEqual({ content: [{ text: "recovered" }] });
    expect(callToolMock).toHaveBeenCalledTimes(2);
  });

  test("permission denied error is not retried", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("permission denied for resource")));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("permission denied");
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  test("'not found' error is not retried", async () => {
    const callToolMock = mock(() => Promise.reject(new Error("Tool not found on server")));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await expect(pool.callTool("test", "my-tool", {})).rejects.toThrow("not found");
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });
});

// -- Transport lifecycle (crash detection) --

describe("transport lifecycle handlers", () => {
  test("transport onclose resets connection state to disconnected", async () => {
    const transport = makeMockTransport();
    const { connectFn } = mockConnectFn(undefined, transport);
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await pool.listTools("test");
    expect(pool.listServers()[0].state).toBe("connected");

    // Fire onclose — attachTransportLifecycle sets this during ensureConnected
    transport.onclose?.();

    expect(pool.listServers()[0].state).toBe("disconnected");
  });

  test("transport onerror resets connection state and records lastError", async () => {
    const transport = makeMockTransport();
    const { connectFn } = mockConnectFn(undefined, transport);
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    await pool.listTools("test");

    // Fire onerror
    transport.onerror?.(new Error("server crashed"));

    const server = pool.listServers()[0];
    expect(server.state).toBe("disconnected");
    expect(server.lastError).toBe("server crashed");
  });

  test("transport onclose is a no-op if already disconnected", async () => {
    const transport = makeMockTransport();
    const { connectFn } = mockConnectFn(undefined, transport);
    const pool = new ServerPool(makeConfig({ test: { command: "echo" } }), undefined, connectFn, silentLogger);

    // Connect then disconnect
    await pool.listTools("test");
    await pool.disconnect("test");
    expect(pool.listServers()[0].state).toBe("disconnected");

    // Fire onclose after already disconnected — should be a no-op
    transport.onclose?.();

    expect(pool.listServers()[0].state).toBe("disconnected");
  });
});

// -- Config-triggered reconnect --

describe("ServerPool.updateConfig reconnect", () => {
  test("config change on connected server triggers disconnect + reconnect", async () => {
    let connectCount = 0;
    const connectFn: ConnectFn = mock(() => {
      connectCount++;
      return Promise.resolve({
        client: makeMockClient() as unknown as Client,
        transport: makeMockTransport() as unknown as Transport,
      });
    });
    const pool = new ServerPool(makeConfig({ a: { command: "echo" } }), undefined, connectFn, silentLogger);

    // Connect server "a" via public API
    await pool.listTools("a");
    expect(connectCount).toBe(1);

    // Change config for "a"
    const updated = makeConfig({ a: { command: "cat" } });
    pool.updateConfig(updated);

    // Wait for the async disconnect → reconnect chain
    await new Promise((r) => setTimeout(r, 50));

    expect(connectCount).toBe(2);
  });

  test("config change on disconnected server does not trigger reconnect", async () => {
    let connectCount = 0;
    const connectFn: ConnectFn = mock(() => {
      connectCount++;
      return Promise.resolve({
        client: makeMockClient() as unknown as Client,
        transport: makeMockTransport() as unknown as Transport,
      });
    });
    const pool = new ServerPool(makeConfig({ a: { command: "echo" } }), undefined, connectFn, silentLogger);

    // Server is disconnected — don't connect it
    expect(pool.listServers()[0].state).toBe("disconnected");

    const updated = makeConfig({ a: { command: "cat" } });
    pool.updateConfig(updated);

    await new Promise((r) => setTimeout(r, 50));

    // Should NOT have connected because the server wasn't connected before config change
    expect(connectCount).toBe(0);
  });
});

// -- Pending virtual servers --

describe("ServerPool.registerPendingVirtualServer", () => {
  test("callTool awaits pending server before proceeding", async () => {
    const callToolMock = mock(() => Promise.resolve({ content: [{ text: "ok" }] }));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({}), undefined, connectFn, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });

    pool.registerPendingVirtualServer("_test", startPromise);

    // Start callTool — it should block on the pending promise
    const callPromise = pool.callTool("_test", "my-tool", { x: 1 });

    // Register the virtual server and resolve the promise
    const client = makeMockClient({ callTool: callToolMock });
    const transport = makeMockTransport();
    pool.registerVirtualServer("_test", client as unknown as Client, transport as unknown as Transport);
    resolve();

    const result = await callPromise;
    expect(result).toEqual({ content: [{ text: "ok" }] });
  });

  test("listServers shows pending servers as connecting", () => {
    const pool = new ServerPool(makeConfig({ a: { command: "echo" } }), undefined, undefined, silentLogger);

    pool.registerPendingVirtualServer("_test", new Promise(() => {}));

    const servers = pool.listServers();
    const pending = servers.find((s) => s.name === "_test");
    expect(pending).toBeDefined();
    expect(pending?.state).toBe("connecting");
    expect(pending?.transport).toBe("virtual");
  });

  test("listServers does not duplicate once registered", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });
    pool.registerPendingVirtualServer("_test", startPromise);

    const client = makeMockClient();
    const transport = makeMockTransport();
    pool.registerVirtualServer("_test", client as unknown as Client, transport as unknown as Transport);
    resolve();
    await startPromise;

    const servers = pool.listServers();
    const matching = servers.filter((s) => s.name === "_test");
    expect(matching).toHaveLength(1);
    expect(matching[0].state).toBe("connected");
  });

  test("listTools awaits all pending servers", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });
    pool.registerPendingVirtualServer("_test", startPromise);

    const toolMap = new Map([
      ["my-tool", { name: "my-tool", server: "_test", description: "test", inputSchema: {}, signature: "my-tool()" }],
    ]);
    const client = makeMockClient();
    const transport = makeMockTransport();
    pool.registerVirtualServer("_test", client as unknown as Client, transport as unknown as Transport, toolMap);

    // Resolve the pending promise so listTools can proceed
    resolve();

    const tools = await pool.listTools();
    expect(tools.some((t) => t.name === "my-tool")).toBe(true);
  });

  test("listTools(serverName) awaits pending server before checking connections", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });
    pool.registerPendingVirtualServer("_test", startPromise);

    const toolMap = new Map([
      ["my-tool", { name: "my-tool", server: "_test", description: "test", inputSchema: {}, signature: "my-tool()" }],
    ]);
    const client = makeMockClient();
    const transport = makeMockTransport();

    // Start listTools for specific server — should block on pending
    const toolsPromise = pool.listTools("_test");

    // Register server and resolve
    pool.registerVirtualServer("_test", client as unknown as Client, transport as unknown as Transport, toolMap);
    resolve();

    const tools = await toolsPromise;
    expect(tools.some((t) => t.name === "my-tool")).toBe(true);
  });

  test("awaitPendingServers resolves when all pending servers settle", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });
    pool.registerPendingVirtualServer("_test", startPromise);
    resolve();

    // Should not hang
    await pool.awaitPendingServers();
  });

  test("callTool throws 'not found' after pending server fails to start", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    // Register a pending server whose startup fails (the IIFE catches and resolves)
    pool.registerPendingVirtualServer(
      "_broken",
      (async () => {
        throw new Error("worker crash");
      })(),
    );

    // Wait for the pending promise to settle
    await pool.awaitPendingServers();

    // Now callTool should throw with the startup error since the server failed
    await expect(pool.callTool("_broken", "tool", {})).rejects.toThrow(
      'Virtual server "_broken" failed to start: worker crash',
    );
  });

  test("failed pending server does not block other operations", async () => {
    const pool = new ServerPool(makeConfig({ a: { command: "echo" } }), undefined, undefined, silentLogger);
    const { connectFn } = mockConnectFn();
    const poolWithConnect = new ServerPool(makeConfig({ a: { command: "echo" } }), undefined, connectFn, silentLogger);

    // Register a pending server that fails
    poolWithConnect.registerPendingVirtualServer("_broken", Promise.reject(new Error("worker crash")));

    // listServers should still work
    const servers = poolWithConnect.listServers();
    expect(servers.some((s) => s.name === "a")).toBe(true);
  });

  test("failed pending server shows error state in listServers", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    pool.registerPendingVirtualServer(
      "_broken",
      (async () => {
        throw new Error("worker crash");
      })(),
    );

    // While pending, should show as connecting
    const before = pool.listServers();
    const pending = before.find((s) => s.name === "_broken");
    expect(pending).toBeDefined();
    expect(pending?.state).toBe("connecting");

    // After settling, should show as error with lastError
    await pool.awaitPendingServers();

    const after = pool.listServers();
    const failed = after.find((s) => s.name === "_broken");
    expect(failed).toBeDefined();
    expect(failed?.state).toBe("error");
    expect(failed?.lastError).toBe("worker crash");
    expect(failed?.transport).toBe("virtual");
  });

  test("hasPendingServers returns true while server is starting, false after settled", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });
    pool.registerPendingVirtualServer("_test", startPromise);

    expect(pool.hasPendingServers()).toBe(true);

    resolve();
    await pool.awaitPendingServers();

    expect(pool.hasPendingServers()).toBe(false);
  });

  test("hasPendingServers returns false when pool has no pending servers", () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);
    expect(pool.hasPendingServers()).toBe(false);
  });

  test("hasPendingServers returns false after failed pending server settles", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    pool.registerPendingVirtualServer(
      "_broken",
      (async () => {
        throw new Error("startup failed");
      })(),
    );

    expect(pool.hasPendingServers()).toBe(true);
    await pool.awaitPendingServers();
    await Promise.resolve();

    expect(pool.hasPendingServers()).toBe(false);
  });

  test("hasPendingServers returns false after startup timeout elapses", async () => {
    const pool = new ServerPool(makeConfig({}), undefined, undefined, silentLogger);

    // Never-settling promise simulates a hung server startup
    pool.registerPendingVirtualServer("_test", new Promise(() => {}), 1);

    expect(pool.hasPendingServers()).toBe(true);
    await pool.awaitPendingServers();

    expect(pool.hasPendingServers()).toBe(false);
  });

  test("server registered after timeout is still usable", async () => {
    const callToolMock = mock(() => Promise.resolve({ content: [{ text: "ok" }] }));
    const { connectFn } = mockConnectFn({ callTool: callToolMock });
    const pool = new ServerPool(makeConfig({}), undefined, connectFn, silentLogger);

    let resolve!: () => void;
    const startPromise = new Promise<void>((r) => {
      resolve = r;
    });

    // 1ms timeout — will fire before resolve() is called
    pool.registerPendingVirtualServer("_test", startPromise, 1);

    // Wait for timeout to clear the pending entry
    await pool.awaitPendingServers();
    expect(pool.hasPendingServers()).toBe(false);

    // Even after timeout, the underlying startup can still succeed and register
    const client = makeMockClient({ callTool: callToolMock });
    const transport = makeMockTransport();
    pool.registerVirtualServer("_test", client as unknown as Client, transport as unknown as Transport);
    resolve();

    // Server is now usable
    const result = await pool.callTool("_test", "my-tool", {});
    expect(result).toEqual({ content: [{ text: "ok" }] });
  });
});

describe("safeStderrWrite", () => {
  test("writes to stderr normally", () => {
    // Should not throw
    safeStderrWrite("test output\n");
  });

  test("swallows EPIPE errors from process.stderr.write", () => {
    const original = process.stderr.write;
    process.stderr.write = (() => {
      const err = new Error("EPIPE: broken pipe, write");
      (err as NodeJS.ErrnoException).code = "EPIPE";
      throw err;
    }) as typeof process.stderr.write;

    try {
      // Should not throw despite EPIPE
      expect(() => safeStderrWrite("test\n")).not.toThrow();
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("ServerPool.restart", () => {
  test("restart without name restarts all connected servers in parallel", async () => {
    const connectCalls: string[] = [];
    const connectFn: ConnectFn = mock((name: string) => {
      connectCalls.push(name);
      return Promise.resolve({
        client: makeMockClient() as unknown as Client,
        transport: makeMockTransport() as unknown as Transport,
      });
    });
    const pool = new ServerPool(
      makeConfig({ a: { command: "echo" }, b: { command: "cat" }, c: { command: "ls" } }),
      undefined,
      connectFn,
      silentLogger,
    );

    // Connect a and b, leave c disconnected
    await pool.listTools("a");
    await pool.listTools("b");
    connectCalls.length = 0;

    await pool.restart();

    // Both a and b should have been restarted, c should not
    expect(connectCalls).toContain("a");
    expect(connectCalls).toContain("b");
    expect(connectCalls).not.toContain("c");
    expect(connectCalls).toHaveLength(2);
  });

  test("restart without name skips virtual servers", async () => {
    const connectCalls: string[] = [];
    const connectFn: ConnectFn = mock((name: string) => {
      connectCalls.push(name);
      return Promise.resolve({
        client: makeMockClient() as unknown as Client,
        transport: makeMockTransport() as unknown as Transport,
      });
    });
    const pool = new ServerPool(makeConfig({ a: { command: "echo" } }), undefined, connectFn, silentLogger);

    // Connect server "a" via config
    await pool.listTools("a");

    // Register a virtual server
    pool.registerVirtualServer(
      "_virtual",
      makeMockClient() as unknown as Client,
      makeMockTransport() as unknown as Transport,
    );

    connectCalls.length = 0;

    await pool.restart();

    // Only "a" should be restarted, not the virtual server
    expect(connectCalls).toContain("a");
    expect(connectCalls).not.toContain("_virtual");
    expect(connectCalls).toHaveLength(1);

    // Virtual server should still be listed as connected
    const servers = pool.listServers();
    const virtualServer = servers.find((s) => s.name === "_virtual");
    expect(virtualServer?.state).toBe("connected");
  });

  test("ensureConnected on disconnected virtual server throws clear error", async () => {
    const connectFn: ConnectFn = mock(() => {
      return Promise.resolve({
        client: makeMockClient() as unknown as Client,
        transport: makeMockTransport() as unknown as Transport,
      });
    });
    const pool = new ServerPool(makeConfig({}), undefined, connectFn, silentLogger);

    // Register and then disconnect a virtual server
    pool.registerVirtualServer(
      "_test",
      makeMockClient() as unknown as Client,
      makeMockTransport() as unknown as Transport,
    );
    await pool.disconnect("_test");

    // Attempting to use the disconnected virtual server should throw
    await expect(pool.callTool("_test", "some-tool", {})).rejects.toThrow(/Virtual server "_test" failed to start/);
  });

  test("restart logs errors for failed servers but does not throw", async () => {
    let firstConnect = true;
    const connectFn: ConnectFn = mock((name: string) => {
      // On reconnect (after restart), fail for server "b"
      if (!firstConnect && name === "b") return Promise.reject(new Error("connection refused"));
      return Promise.resolve({
        client: makeMockClient() as unknown as Client,
        transport: makeMockTransport() as unknown as Transport,
      });
    });
    const pool = new ServerPool(
      makeConfig({ a: { command: "echo" }, b: { command: "cat" } }),
      undefined,
      connectFn,
      silentLogger,
    );

    // Connect both servers
    await pool.listTools("a");
    await pool.listTools("b");
    firstConnect = false;

    // Should not throw despite server "b" failing on restart
    await pool.restart();
  });
});
