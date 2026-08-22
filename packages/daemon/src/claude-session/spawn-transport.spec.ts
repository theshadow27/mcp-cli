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

  test("worktree sessions follow the default transport like any other (#3063)", () => {
    // Worktree spawns used to be pinned to ws so ContainmentGuard could ride the
    // can_use_tool round-trip. That pin routed every sprint worker onto the very
    // sdk-url path #3003 is about, so #3005's fix never reached them. stdio now
    // carries can_use_tool too (--permission-prompt-tool stdio), so the pin is gone.
    const server = makeServer("stdio");
    expect(server.prepareSession("wt", { prompt: "hi", worktree: "my-tree" }).transport).toBe("stdio");
  });

  test("an explicit transport override still wins on a worktree session", () => {
    const server = makeServer("ws");
    expect(server.prepareSession("wt", { prompt: "hi", worktree: "my-tree", transport: "stdio" }).transport).toBe(
      "stdio",
    );

    const stdioDefault = makeServer("stdio");
    expect(stdioDefault.prepareSession("wt", { prompt: "hi", worktree: "my-tree", transport: "ws" }).transport).toBe(
      "ws",
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

  test("the truncation marker sits in front of the kept tail, not after it", () => {
    // slice(-N) drops the HEAD, so a trailing "(truncated)" claimed the wrong end
    // was cut. The fatal line is always last — keep it, and say the head is gone.
    const msg = describeSpawnExit("abc-123", `${"x".repeat(10_000)} FATAL: policy denied`);
    expect(msg).toContain("(truncated) ");
    expect(msg.indexOf("(truncated)")).toBeLessThan(msg.indexOf("FATAL: policy denied"));
    expect(msg).toContain("FATAL: policy denied");
  });
});
