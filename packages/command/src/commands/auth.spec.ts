import { describe, expect, mock, test } from "bun:test";
import type { AuthStatusResult, ServerAuthStatus, TriggerAuthResult } from "@mcp-cli/core";
import type { AuthDeps } from "./auth";
import { cmdAuth, extractAuthFlags, stripAnsi } from "./auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<AuthDeps>): AuthDeps & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    ipcCall: mock(() => Promise.resolve({} as never)),
    log: (msg: string) => output.push(msg),
    logError: (msg: string) => errors.push(msg),
    ...overrides,
  };
}

function fakeServer(overrides?: Partial<ServerAuthStatus>): ServerAuthStatus {
  return {
    server: "test-server",
    transport: "http",
    authSupport: "oauth",
    status: "authenticated",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractAuthFlags
// ---------------------------------------------------------------------------

describe("extractAuthFlags", () => {
  test("extracts --status flag", () => {
    const result = extractAuthFlags(["my-server", "--status"]);
    expect(result.status).toBe(true);
    expect(result.help).toBe(false);
    expect(result.rest).toEqual(["my-server"]);
  });

  test("extracts --help flag", () => {
    const result = extractAuthFlags(["--help"]);
    expect(result.help).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("extracts -h flag", () => {
    const result = extractAuthFlags(["-h"]);
    expect(result.help).toBe(true);
  });

  test("passes through unknown args", () => {
    const result = extractAuthFlags(["server-name", "--unknown"]);
    expect(result.rest).toEqual(["server-name", "--unknown"]);
    expect(result.status).toBe(false);
    expect(result.help).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  test("removes ANSI escape sequences", () => {
    expect(stripAnsi("\x1b[32mauthenticated\x1b[0m")).toBe("authenticated");
  });

  test("handles strings without ANSI codes", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// cmdAuth --help
// ---------------------------------------------------------------------------

describe("cmdAuth --help", () => {
  test("prints help and returns", async () => {
    const deps = makeDeps();
    await cmdAuth(["--help"], deps);
    expect(deps.output.length).toBe(1);
    expect(deps.output[0]).toContain("mcx auth");
    expect(deps.output[0]).toContain("--status");
    expect(deps.output[0]).toContain("--json");
  });

  test("-h also prints help", async () => {
    const deps = makeDeps();
    await cmdAuth(["-h"], deps);
    expect(deps.output.length).toBe(1);
    expect(deps.output[0]).toContain("mcx auth");
  });
});

// ---------------------------------------------------------------------------
// cmdAuth (no args) — list servers
// ---------------------------------------------------------------------------

describe("cmdAuth (no args)", () => {
  test("lists servers with auth status", async () => {
    const servers: ServerAuthStatus[] = [
      fakeServer({ server: "github", transport: "http", authSupport: "oauth", status: "authenticated" }),
      fakeServer({ server: "filesystem", transport: "stdio", authSupport: "none", status: "unknown" }),
    ];
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ servers } as AuthStatusResult as never)),
    });

    await cmdAuth([], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("authStatus");
    // Header + 2 server rows
    expect(deps.output.length).toBe(3);
    expect(stripAnsi(deps.output[0])).toContain("SERVER");
    expect(stripAnsi(deps.output[1])).toContain("github");
    expect(stripAnsi(deps.output[2])).toContain("filesystem");
  });

  test("shows message when no servers", async () => {
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ servers: [] } as AuthStatusResult as never)),
    });

    await cmdAuth([], deps);
    expect(deps.output[0]).toBe("No servers configured.");
  });

  test("outputs JSON with --json flag", async () => {
    const result: AuthStatusResult = { servers: [fakeServer()] };
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(result as never)),
    });

    await cmdAuth(["--json"], deps);

    const parsed = JSON.parse(deps.output[0]);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].server).toBe("test-server");
  });
});

// ---------------------------------------------------------------------------
// cmdAuth <server> --status
// ---------------------------------------------------------------------------

describe("cmdAuth <server> --status", () => {
  test("checks auth status for a server", async () => {
    const entry = fakeServer({ server: "notion", status: "authenticated", authSupport: "oauth" });
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ servers: [entry] } as AuthStatusResult as never)),
    });

    await cmdAuth(["notion", "--status"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("authStatus", { server: "notion" });
    expect(deps.output.length).toBeGreaterThanOrEqual(3);
    expect(stripAnsi(deps.output.join("\n"))).toContain("notion");
    expect(stripAnsi(deps.output.join("\n"))).toContain("authenticated");
  });

  test("shows expiry when present", async () => {
    const entry = fakeServer({
      server: "notion",
      status: "authenticated",
      expiresAt: Date.now() + 300_000, // 5 minutes from now
    });
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ servers: [entry] } as AuthStatusResult as never)),
    });

    await cmdAuth(["notion", "--status"], deps);

    const text = stripAnsi(deps.output.join("\n"));
    expect(text).toContain("Expires");
  });

  test("outputs JSON with --json --status", async () => {
    const entry = fakeServer({ server: "notion" });
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve({ servers: [entry] } as AuthStatusResult as never)),
    });

    await cmdAuth(["notion", "--status", "--json"], deps);

    const parsed = JSON.parse(deps.output[0]);
    expect(parsed.server).toBe("notion");
  });
});

// ---------------------------------------------------------------------------
// cmdAuth <server> — trigger auth
// ---------------------------------------------------------------------------

describe("cmdAuth <server>", () => {
  test("triggers auth and reports result", async () => {
    const result: TriggerAuthResult = { ok: true, message: "Authenticated successfully" };
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(result as never)),
    });

    await cmdAuth(["notion"], deps);

    expect(deps.ipcCall).toHaveBeenCalledWith("triggerAuth", { server: "notion" });
    expect(deps.errors[0]).toBe("Authenticating with notion...");
    expect(deps.errors[1]).toBe("Authenticated successfully");
  });

  test("outputs JSON with --json flag", async () => {
    const result: TriggerAuthResult = { ok: true, message: "Done" };
    const deps = makeDeps({
      ipcCall: mock(() => Promise.resolve(result as never)),
    });

    await cmdAuth(["notion", "--json"], deps);

    const parsed = JSON.parse(deps.output[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.server).toBe("notion");
    expect(parsed.message).toBe("Done");
  });
});
