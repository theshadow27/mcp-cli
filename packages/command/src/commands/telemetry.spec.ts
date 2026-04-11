import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { testOptions } from "../../../../test/test-options";
import { cmdTelemetry } from "./telemetry";

/** All env vars checked by isCI() — must be saved and restored across tests */
const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "JENKINS_URL",
  "BUILDKITE",
  "CIRCLECI",
  "GITLAB_CI",
  "TRAVIS",
  "TF_BUILD",
] as const;

describe("cmdTelemetry", () => {
  const originalEnv = process.env.MCX_NO_TELEMETRY;
  const originalCIVars: Record<string, string | undefined> = {};
  for (const v of CI_ENV_VARS) originalCIVars[v] = process.env[v];

  /** Unset an env var properly (not assigning undefined which coerces to string "undefined") */
  function unsetEnv(key: string): void {
    delete process.env[key];
  }

  function unsetAllCIVars(): void {
    for (const v of CI_ENV_VARS) unsetEnv(v);
  }

  afterEach(() => {
    if (originalEnv === undefined) {
      unsetEnv("MCX_NO_TELEMETRY");
    } else {
      process.env.MCX_NO_TELEMETRY = originalEnv;
    }
    for (const v of CI_ENV_VARS) {
      if (originalCIVars[v] === undefined) {
        unsetEnv(v);
      } else {
        process.env[v] = originalCIVars[v];
      }
    }
  });

  test("status shows enabled by default", () => {
    using _opts = testOptions();
    unsetEnv("MCX_NO_TELEMETRY");
    unsetAllCIVars();

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
    unsetEnv("MCX_NO_TELEMETRY");
    unsetAllCIVars();

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
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      cmdTelemetry(["off"]);
      const config = JSON.parse(readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8"));
      expect(config.telemetry).toBe(false);
      expect(config.trustClaude).toBe(true); // preserves existing config
      expect(logSpy.mock.calls[0][0]).toContain("disabled");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("on writes telemetry: true to config", () => {
    using opts = testOptions({ files: { "config.json": { telemetry: false } } });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      cmdTelemetry(["on"]);
      const config = JSON.parse(readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8"));
      expect(config.telemetry).toBe(true);
      expect(logSpy.mock.calls[0][0]).toContain("enabled");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("default subcommand is status", () => {
    using _opts = testOptions();
    unsetEnv("MCX_NO_TELEMETRY");
    unsetAllCIVars();

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
