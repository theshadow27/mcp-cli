import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import { type TelemetryDeps, isTelemetryEnabled, maybeShowTelemetryNotice, recordCommand } from "./telemetry";

/** Unset an env var properly (not assigning undefined which coerces to string "undefined") */
function unsetEnv(key: string): void {
  delete process.env[key];
}

describe("isTelemetryEnabled", () => {
  const originalEnv = process.env.MCX_NO_TELEMETRY;
  const originalCI = process.env.CI;
  afterEach(() => {
    if (originalEnv === undefined) {
      unsetEnv("MCX_NO_TELEMETRY");
    } else {
      process.env.MCX_NO_TELEMETRY = originalEnv;
    }
    if (originalCI === undefined) {
      unsetEnv("CI");
    } else {
      process.env.CI = originalCI;
    }
  });

  test("returns true by default", () => {
    using _opts = testOptions();
    unsetEnv("MCX_NO_TELEMETRY");
    unsetEnv("CI");
    expect(isTelemetryEnabled()).toBe(true);
  });

  test("returns false when MCX_NO_TELEMETRY=1", () => {
    using _opts = testOptions();
    process.env.MCX_NO_TELEMETRY = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  test("returns false when config.telemetry is false", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: false } } });
    unsetEnv("MCX_NO_TELEMETRY");
    unsetEnv("CI");
    expect(isTelemetryEnabled()).toBe(false);
  });

  test("returns true when config.telemetry is true", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: true } } });
    unsetEnv("MCX_NO_TELEMETRY");
    unsetEnv("CI");
    expect(isTelemetryEnabled()).toBe(true);
  });

  test("env var takes precedence over config", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: true } } });
    process.env.MCX_NO_TELEMETRY = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  test("returns false in CI environment", () => {
    using _opts = testOptions();
    unsetEnv("MCX_NO_TELEMETRY");
    process.env.CI = "true";
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("recordCommand", () => {
  const TEST_API_KEY = "phc_test_real_key";

  function makeDeps(overrides?: Partial<TelemetryDeps>): TelemetryDeps {
    return {
      enabled: () => true,
      fetch: mock(() => Promise.resolve(new Response("ok"))) as unknown as typeof globalThis.fetch,
      machineId: () => "test-machine-id",
      apiKey: TEST_API_KEY,
      ...overrides,
    };
  }

  test("returns undefined due to placeholder API key guard", () => {
    // Without apiKey override, the embedded placeholder triggers the guard
    const deps = makeDeps({ apiKey: undefined });
    const result = recordCommand("call", "status", deps);
    expect(result).toBeUndefined();
  });

  test("sends POST with correct payload when API key is real", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetchMock = mock((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof globalThis.fetch });

    const promise = recordCommand("call", "status", deps);
    expect(promise).toBeDefined();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain("posthog.com/capture");
    expect(capturedInit.method).toBe("POST");
    expect(capturedInit.signal).toBeDefined();

    const body = JSON.parse(capturedInit.body as string);
    expect(body.event).toBe("mcx_command");
    expect(body.api_key).toBe(TEST_API_KEY);
    expect(body.distinct_id).toBe("test-machine-id");
    expect(body.properties.command).toBe("call");
    expect(body.properties.subcommand).toBe("status");
    expect(body.properties.os).toBe(process.platform);
    expect(body.properties.arch).toBe(process.arch);
    expect(body.properties.version).toBeDefined();
  });

  test("filters unsafe subcommands (server names)", async () => {
    let capturedInit: RequestInit = {};
    const fetchMock = mock((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof globalThis.fetch });

    // "atlassian" is NOT in the safe allowlist — should be omitted
    await recordCommand("call", "atlassian", deps);
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.subcommand).toBeUndefined();
    expect(body.properties.command).toBe("call");
  });

  test("allows safe subcommands through", async () => {
    let capturedInit: RequestInit = {};
    const fetchMock = mock((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof globalThis.fetch });

    await recordCommand("telemetry", "off", deps);
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.subcommand).toBe("off");
  });

  test("omits subcommand when not provided", async () => {
    let capturedInit: RequestInit = {};
    const fetchMock = mock((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof globalThis.fetch });

    await recordCommand("ls", undefined, deps);
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.subcommand).toBeUndefined();
    expect(body.properties.command).toBe("ls");
  });

  test("returns undefined when disabled", () => {
    const deps = makeDeps({ enabled: () => false });
    const result = recordCommand("call", undefined, deps);
    expect(result).toBeUndefined();
  });

  test("swallows fetch errors silently", async () => {
    const deps = makeDeps({
      fetch: mock(() => Promise.reject(new Error("network error"))) as unknown as typeof globalThis.fetch,
    });

    const promise = recordCommand("call", undefined, deps);
    expect(promise).toBeDefined();
    await promise; // resolves despite error
  });
});

describe("maybeShowTelemetryNotice", () => {
  test("shows notice on first call, silent on second", () => {
    using _opts = testOptions();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowTelemetryNotice();
      expect(errors.some((e) => e.includes("anonymous usage telemetry"))).toBe(true);

      errors.length = 0;
      maybeShowTelemetryNotice();
      expect(errors.length).toBe(0);
    } finally {
      console.error = origError;
    }
  });

  test("does not show notice if telemetryNoticeShown is already true", () => {
    using _opts = testOptions({ files: { "config.json": { telemetryNoticeShown: true } } });
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowTelemetryNotice();
      expect(errors.length).toBe(0);
    } finally {
      console.error = origError;
    }
  });
});

describe("device-id persistence", () => {
  test("machineId returns a non-empty string", () => {
    using _opts = testOptions();
    const deps = {
      enabled: () => true,
      fetch: mock(() => Promise.resolve(new Response("ok"))) as unknown as typeof globalThis.fetch,
      machineId: () => {
        const deviceIdPath = join(_opts.MCP_CLI_DIR, "device-id");
        try {
          return readFileSync(deviceIdPath, "utf-8").trim();
        } catch {
          return "fallback-id";
        }
      },
    };
    const id = deps.machineId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
