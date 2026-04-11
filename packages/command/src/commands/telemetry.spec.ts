import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { testOptions } from "../../../../test/test-options";
import { cmdTelemetry } from "./telemetry";

describe("cmdTelemetry", () => {
  const originalEnv = process.env.MCX_NO_TELEMETRY;
  afterEach(() => {
    if (originalEnv === undefined) {
      process.env.MCX_NO_TELEMETRY = undefined as unknown as string;
    } else {
      process.env.MCX_NO_TELEMETRY = originalEnv;
    }
  });

  test("status shows enabled by default", () => {
    using _opts = testOptions();
    process.env.MCX_NO_TELEMETRY = undefined as unknown as string;

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      cmdTelemetry(["status"]);
      expect(logSpy.mock.calls[0][0]).toContain("enabled");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("status shows disabled when config is false", () => {
    using _opts = testOptions({ files: { "config.json": { telemetry: false } } });
    process.env.MCX_NO_TELEMETRY = undefined as unknown as string;

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      cmdTelemetry(["status"]);
      expect(logSpy.mock.calls[0][0]).toContain("disabled");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("status shows env var override", () => {
    using _opts = testOptions();
    process.env.MCX_NO_TELEMETRY = "1";

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      cmdTelemetry(["status"]);
      expect(logSpy.mock.calls[0][0]).toContain("MCX_NO_TELEMETRY");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("off writes telemetry: false to config", () => {
    using opts = testOptions({ files: { "config.json": { trustClaude: true } } });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      cmdTelemetry(["off"]);
      const config = JSON.parse(readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8"));
      expect(config.telemetry).toBe(false);
      expect(config.trustClaude).toBe(true); // preserves existing config
    } finally {
      errSpy.mockRestore();
    }
  });

  test("on writes telemetry: true to config", () => {
    using opts = testOptions({ files: { "config.json": { telemetry: false } } });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      cmdTelemetry(["on"]);
      const config = JSON.parse(readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8"));
      expect(config.telemetry).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("default subcommand is status", () => {
    using _opts = testOptions();
    process.env.MCX_NO_TELEMETRY = undefined as unknown as string;

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      cmdTelemetry([]);
      expect(logSpy.mock.calls[0][0]).toContain("Telemetry:");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("unknown subcommand exits with 1", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => cmdTelemetry(["bogus"])).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
