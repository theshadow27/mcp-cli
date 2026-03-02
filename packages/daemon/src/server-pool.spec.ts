import { describe, expect, test } from "bun:test";
import type { HttpServerConfig, SseServerConfig, StdioServerConfig } from "@mcp-cli/core";
import { wrapTransportError } from "./server-pool.js";

const stdio: StdioServerConfig = { command: "npx", args: ["-y", "my-server"] };
const http: HttpServerConfig = { type: "http", url: "https://example.com/mcp" };
const sse: SseServerConfig = { type: "sse", url: "https://sse.example.com/events" };

function errWithCode(message: string, code: string): Error {
  const e = new Error(message);
  (e as unknown as Record<string, unknown>).code = code;
  return e;
}

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
