import { afterEach, describe, expect, mock, test } from "bun:test";
import { testOptions } from "../../../test/test-options";
import { type TelemetryDeps, isTelemetryEnabled, recordCommand } from "./telemetry";

describe("isTelemetryEnabled", () => {
  const originalEnv = process.env.MCX_NO_TELEMETRY;
  afterEach(() => {
    if (originalEnv === undefined) {
      process.env.MCX_NO_TELEMETRY = undefined as unknown as string;
    } else {
      process.env.MCX_NO_TELEMETRY = originalEnv;
    }
  });

  test("returns true by default", () => {
    using _opts = testOptions();
    process.env.MCX_NO_TELEMETRY = undefined as unknown as string;
    expect(isTelemetryEnabled()).toBe(true);
  });

  test("returns false when MCX_NO_TELEMETRY=1", () => {
    using _opts = testOptions();
    process.env.MCX_NO_TELEMETRY = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  test("returns false when config.telemetry is false", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: false } } });
    process.env.MCX_NO_TELEMETRY = undefined as unknown as string;
    expect(isTelemetryEnabled()).toBe(false);
  });

  test("returns true when config.telemetry is true", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: true } } });
    process.env.MCX_NO_TELEMETRY = undefined as unknown as string;
    expect(isTelemetryEnabled()).toBe(true);
  });

  test("env var takes precedence over config", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: true } } });
    process.env.MCX_NO_TELEMETRY = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("recordCommand", () => {
  function makeDeps(overrides?: Partial<TelemetryDeps>): TelemetryDeps {
    return {
      enabled: () => true,
      fetch: mock(() => Promise.resolve(new Response("ok"))) as unknown as typeof globalThis.fetch,
      machineId: () => "test-machine-id",
      ...overrides,
    };
  }

  test("sends POST to PostHog with correct payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetchMock = mock((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof globalThis.fetch });

    const promise = recordCommand("call", "save", deps);
    expect(promise).toBeDefined();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain("posthog.com/capture");
    expect(capturedInit.method).toBe("POST");

    const body = JSON.parse(capturedInit.body as string);
    expect(body.event).toBe("mcx_command");
    expect(body.distinct_id).toBe("test-machine-id");
    expect(body.properties.command).toBe("call");
    expect(body.properties.subcommand).toBe("save");
    expect(body.properties.os).toBe(process.platform);
    expect(body.properties.arch).toBe(process.arch);
    expect(body.properties.version).toBeDefined();
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

    // Should not throw
    const promise = recordCommand("call", undefined, deps);
    expect(promise).toBeDefined();
    await promise; // resolves despite error
  });
});
