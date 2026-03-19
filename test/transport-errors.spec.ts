/**
 * Integration test: verify transport error messages with live daemon.
 *
 * Exercises the full stack: ensureConnected() → wrapTransportError() →
 * conn.lastError → listServers(). Verifies that friendly, actionable
 * error messages surface correctly for each transport type.
 *
 * The MCP SDK wraps low-level system errors (ECONNREFUSED, ENOTFOUND, etc.)
 * in higher-level messages. wrapTransportError handles this by:
 * 1. Walking err.cause chains to find the original system error code
 * 2. Pattern-matching SDK message formats (e.g., "Unable to connect")
 *
 * Performance: all tests share a single daemon instance (started once in
 * beforeAll) to avoid per-test daemon startup overhead (~5s each).
 *
 * @see https://github.com/theshadow27/mcp-cli/issues/855
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestDaemon } from "./harness";
import { createTestDir, rpc, startTestDaemon } from "./harness";

setDefaultTimeout(30_000);

/** Force a connection attempt and return the error (if any) from the RPC response. */
async function triggerConnect(socketPath: string, server: string): Promise<string | undefined> {
  const res = await rpc(socketPath, "listTools", { server });
  return res.error?.message;
}

/** Get server status from listServers. */
async function getServerStatus(
  socketPath: string,
  server: string,
): Promise<{ name: string; state: string; lastError?: string } | undefined> {
  const res = await rpc(socketPath, "listServers");
  const servers = res.result as Array<{ name: string; state: string; lastError?: string }>;
  return servers.find((s) => s.name === server);
}

// ---------------------------------------------------------------------------
// Shared daemon — all transport error tests use a single daemon instance
// with all server configs registered upfront.
// ---------------------------------------------------------------------------

let daemon: TestDaemon;

beforeAll(async () => {
  const dir = createTestDir();
  const script = join(dir, "no-exec.sh");
  writeFileSync(script, "#!/bin/sh\necho hello");
  chmodSync(script, 0o644); // not executable

  daemon = await startTestDaemon(
    {
      // Stdio servers
      bogus: { command: "nonexistent-mcp-server-binary-xyz" },
      noperm: { command: script },
      crasher: { command: "bun", args: [resolve("test/exit-immediately.ts")] },
      // HTTP servers
      deadhttp: { type: "http", url: "http://127.0.0.1:19999/mcp" },
      baddns: { type: "http", url: "http://this-host-does-not-resolve.invalid/mcp" },
      // SSE server
      deadsse: { type: "sse", url: "http://127.0.0.1:19998/events" },
      // Healthy server (for listServers tests)
      echo: { command: "bun", args: [resolve("test/echo-server.ts")] },
    },
    { dir },
  );
});

afterAll(async () => {
  await daemon?.kill();
});

// ---------------------------------------------------------------------------
// Stdio transport errors
// ---------------------------------------------------------------------------
describe("Stdio transport errors", () => {
  test("command not found → friendly message with command name and PATH hint", async () => {
    const rpcError = await triggerConnect(daemon.socketPath, "bogus");
    expect(rpcError).toContain('command "nonexistent-mcp-server-binary-xyz" not found');
    expect(rpcError).toContain("PATH");

    const status = await getServerStatus(daemon.socketPath, "bogus");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain('command "nonexistent-mcp-server-binary-xyz" not found');
    expect(status?.lastError).toContain("PATH");
  });

  test("permission denied → friendly message with file path", async () => {
    const rpcError = await triggerConnect(daemon.socketPath, "noperm");
    expect(rpcError).toContain("permission denied");

    const status = await getServerStatus(daemon.socketPath, "noperm");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("permission denied");
  });

  test("process exits immediately → actionable exit message with command", async () => {
    const rpcError = await triggerConnect(daemon.socketPath, "crasher");
    // The MCP SDK wraps the exit as "MCP error -32000: Connection closed".
    // wrapTransportError now matches this pattern and produces an actionable message.
    expect(rpcError).toBeDefined();
    expect(rpcError).toContain('Server "crasher"');
    expect(rpcError).toContain("process exited unexpectedly");
    expect(rpcError).toContain("bun");

    const status = await getServerStatus(daemon.socketPath, "crasher");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("process exited unexpectedly");
  });
});

// ---------------------------------------------------------------------------
// HTTP transport errors
// ---------------------------------------------------------------------------
describe("HTTP transport errors", () => {
  test("connection refused → friendly message with URL", async () => {
    const rpcError = await triggerConnect(daemon.socketPath, "deadhttp");
    expect(rpcError).toBeDefined();
    // The MCP SDK wraps ECONNREFUSED as "Unable to connect..." — wrapTransportError
    // now matches this pattern and produces a URL-specific message.
    expect(rpcError).toContain('Server "deadhttp"');
    expect(rpcError).toContain("could not connect to http://127.0.0.1:19999/mcp");
    expect(rpcError).toContain("Is the server running?");

    const status = await getServerStatus(daemon.socketPath, "deadhttp");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("could not connect to");
  });

  test("DNS failure → DNS-specific message with URL", async () => {
    const rpcError = await triggerConnect(daemon.socketPath, "baddns");
    expect(rpcError).toBeDefined();
    // The MCP SDK wraps ENOTFOUND — wrapTransportError now checks err.cause
    // to recover the original code and distinguish DNS from connection refused.
    expect(rpcError).toContain('Server "baddns"');
    // Should get either DNS-specific or connection-refused message (depends on
    // whether the SDK preserves the cause chain). Either is better than generic.
    const isDnsOrConnectMsg = rpcError?.includes("DNS lookup failed") || rpcError?.includes("could not connect to");
    expect(isDnsOrConnectMsg).toBe(true);

    const status = await getServerStatus(daemon.socketPath, "baddns");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SSE transport errors
// ---------------------------------------------------------------------------
describe("SSE transport errors", () => {
  test("connection refused → friendly message with URL", async () => {
    const rpcError = await triggerConnect(daemon.socketPath, "deadsse");
    expect(rpcError).toBeDefined();
    expect(rpcError).toContain('Server "deadsse"');
    // The MCP SDK wraps as "SSE error: Unable to connect..." — wrapTransportError
    // now matches "unable to connect" pattern for SSE too.
    expect(rpcError).toContain("could not connect to http://127.0.0.1:19998/events");

    const status = await getServerStatus(daemon.socketPath, "deadsse");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("could not connect to");
  });
});

// ---------------------------------------------------------------------------
// listServers: lastError field end-to-end verification
// ---------------------------------------------------------------------------
describe("listServers lastError field", () => {
  test("failed server: state=error, lastError includes server name", async () => {
    await triggerConnect(daemon.socketPath, "bogus");

    const status = await getServerStatus(daemon.socketPath, "bogus");
    expect(status).toBeDefined();
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain('Server "bogus"');
    expect(status?.lastError).toContain("not found");
    // Should NOT leak raw system error codes
    expect(status?.lastError).not.toContain("ENOENT");
  });

  test("healthy server: lastError is undefined after successful connect", async () => {
    await triggerConnect(daemon.socketPath, "echo");

    const status = await getServerStatus(daemon.socketPath, "echo");
    expect(status).toBeDefined();
    expect(status?.state).toBe("connected");
    expect(status?.lastError).toBeUndefined();
  });

  test("daemon remains functional after transport errors", async () => {
    // Trigger failure on bogus server
    await triggerConnect(daemon.socketPath, "bogus");

    // Echo server should still work fine
    const res = await rpc(daemon.socketPath, "callTool", {
      server: "echo",
      tool: "echo",
      arguments: { message: "still alive" },
    });
    expect(res.error).toBeUndefined();
    const content = (res.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe("still alive");
  });
});
