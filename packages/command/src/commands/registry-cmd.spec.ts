import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RegistryResponse } from "../registry/client.js";

const MOCK_RESPONSE: RegistryResponse = {
  servers: [
    {
      server: {
        name: "test",
        title: "Test",
        description: "A test server",
        version: "1.0.0",
      },
      _meta: {
        "com.anthropic.api/mcp-registry": {
          slug: "test",
          displayName: "Test Server",
          oneLiner: "Testing things",
          isAuthless: true,
          toolNames: ["tool1", "tool2"],
        },
      },
    },
  ],
  metadata: { count: 1 },
};

describe("cmdRegistryDispatch", () => {
  let originalFetch: typeof globalThis.fetch;
  let exitCode: number | undefined;
  let stderrOutput: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    exitCode = undefined;
    stderrOutput = [];

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    // Capture process.exit calls
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("search subcommand calls searchRegistry", async () => {
    const { cmdRegistryDispatch } = await import("./registry-cmd.js");
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    // Redirect stdout to capture JSON
    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };

    await cmdRegistryDispatch(["search", "test", "-j"]);

    console.log = origLog;

    expect(capturedUrl).toContain("search=test");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]._meta["com.anthropic.api/mcp-registry"].slug).toBe("test");
  });

  test("list subcommand calls listRegistry", async () => {
    const { cmdRegistryDispatch } = await import("./registry-cmd.js");
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };

    await cmdRegistryDispatch(["list", "-j"]);

    console.log = origLog;

    expect(capturedUrl).not.toContain("search=");
    expect(capturedUrl).toContain("version=latest");
  });

  test("passes --limit flag", async () => {
    const { cmdRegistryDispatch } = await import("./registry-cmd.js");
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const origLog = console.log;
    console.log = () => {};

    await cmdRegistryDispatch(["list", "--limit", "5", "-j"]);

    console.log = origLog;

    expect(capturedUrl).toContain("limit=5");
  });

  test("passes -n short limit flag", async () => {
    const { cmdRegistryDispatch } = await import("./registry-cmd.js");
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const origLog = console.log;
    console.log = () => {};

    await cmdRegistryDispatch(["search", "test", "-n", "3", "-j"]);

    console.log = origLog;

    expect(capturedUrl).toContain("limit=3");
    expect(capturedUrl).toContain("search=test");
  });

  test("defaults to list when no subcommand given", async () => {
    const { cmdRegistryDispatch } = await import("./registry-cmd.js");
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const origErr = console.error;
    console.error = () => {};

    await cmdRegistryDispatch([]);

    console.error = origErr;

    expect(capturedUrl).toContain("version=latest");
    expect(capturedUrl).not.toContain("search=");
  });
});
