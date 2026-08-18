import { describe, expect, test } from "bun:test";
import { silentLogger } from "@mcp-cli/core";
import { resolveTransport } from "./transport-resolver";
import { ClaudeWsServer, describeSpawnExit } from "./ws-server";

// Regression coverage for #3003: `resolveTransport` was dead code and
// `prepareSession` hardcoded `"ws"`, so every spawn on a modern claude took the
// `--sdk-url` remote-control path — which the CLI refuses outright under
// API-key auth, killing the child before it connected. These tests pin the
// wiring (default transport is injectable and honoured) and the diagnostics
// that made the failure invisible.

/** A no-op spawn: these tests never start the server or launch a child. */
function neverSpawn(): never {
  throw new Error("spawn should not be called");
}

function makeServer(defaultTransport?: "ws" | "stdio"): ClaudeWsServer {
  return new ClaudeWsServer({ spawn: neverSpawn, logger: silentLogger, defaultTransport });
}

describe("prepareSession transport selection (#3003)", () => {
  test("uses the injected default transport when the spawn has no override", () => {
    const server = makeServer("stdio");
    expect(server.prepareSession("s1", { prompt: "hi" }).transport).toBe("stdio");
  });

  test("still defaults to ws when no default is injected", () => {
    const server = makeServer();
    expect(server.prepareSession("s1", { prompt: "hi" }).transport).toBe("ws");
  });

  test("a per-spawn override wins over the default", () => {
    const server = makeServer("stdio");
    expect(server.prepareSession("s1", { prompt: "hi", transport: "ws" }).transport).toBe("ws");

    const wsDefault = makeServer("ws");
    expect(wsDefault.prepareSession("s2", { prompt: "hi", transport: "stdio" }).transport).toBe("stdio");
  });

  test("worktree sessions keep ws even when the default is stdio", () => {
    // ContainmentGuard rides the can_use_tool round-trip, which only ws carries;
    // spawnClaude fails closed on stdio+worktree (#2688/#2791). Drop this once
    // #2805 gives stdio parity.
    const server = makeServer("stdio");
    expect(server.prepareSession("wt", { prompt: "hi", worktree: "my-tree" }).transport).toBe("ws");
  });

  test("an explicit stdio override on a worktree session is not silently rewritten", () => {
    // The override is honoured so spawnClaude can fail closed with its own
    // message rather than the guard being bypassed by a quiet downgrade.
    const server = makeServer("ws");
    expect(server.prepareSession("wt", { prompt: "hi", worktree: "my-tree", transport: "stdio" }).transport).toBe(
      "stdio",
    );
  });

  test("resolveTransport picks stdio for the claude versions that ship today", () => {
    // The wire-up point reads this; the version gate is what makes modern
    // claude stop taking the sdk-url path.
    expect(resolveTransport("auto", "2.1.234")).toBe("stdio");
    expect(resolveTransport(undefined, "2.1.234")).toBe("stdio");
    expect(resolveTransport("sdk-url", "2.1.234")).toBe("ws");
    expect(resolveTransport("auto", "2.1.119")).toBe("ws");
    expect(resolveTransport("auto", null)).toBe("ws");
  });
});

describe("describeSpawnExit (#3003)", () => {
  test("quotes the child's stderr and points at the log command", () => {
    const msg = describeSpawnExit(
      "abc-123",
      "Remote Control is disabled by your organization's policy. Contact your organization admin to enable it.\n",
    );
    expect(msg).toContain("Remote Control is disabled by your organization's policy");
    expect(msg).toContain("mcx logs abc-123");
  });

  test("joins multiple stderr lines into one message", () => {
    const msg = describeSpawnExit("abc-123", "first line\n\nsecond line\n");
    expect(msg).toContain("first line | second line");
    expect(msg).not.toContain("\n");
  });

  test("says so explicitly when the child produced no stderr", () => {
    const msg = describeSpawnExit("abc-123", "");
    expect(msg).toContain("no stderr captured");
    expect(msg).toContain("mcx logs abc-123");
  });

  test("truncates a huge stderr ring instead of inlining all of it", () => {
    const msg = describeSpawnExit("abc-123", "x".repeat(10_000));
    expect(msg).toContain("(truncated)");
    expect(msg.length).toBeLessThan(600);
  });
});
