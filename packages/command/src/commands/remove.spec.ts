import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpConfigFile } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import { writeConfigFile } from "./config-file";
import { cmdRemove, parseRemoveArgs } from "./remove";

// parseRemoveArgs tests live in add.spec.ts — these cover the cmdRemove handler

describe("cmdRemove", () => {
  test("removes an existing server from config", async () => {
    using opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: {
            keep: { type: "http", url: "https://keep.com" },
            removeme: { type: "http", url: "https://remove.com" },
          },
        },
      },
    });

    await cmdRemove(["removeme"]);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.keep).toEqual({ type: "http", url: "https://keep.com" });
    expect(config.mcpServers?.removeme).toBeUndefined();
  });

  test("exits with 1 when server not found", async () => {
    using _opts = testOptions({
      files: { "servers.json": { mcpServers: {} } },
    });

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(cmdRemove(["nonexistent"])).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("exits with 1 on empty args", async () => {
    using _opts = testOptions();
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(cmdRemove([])).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("preserves other servers when removing one", async () => {
    using opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: {
            alpha: { command: "a" },
            beta: { command: "b" },
            gamma: { command: "c" },
          },
        },
      },
    });

    await cmdRemove(["beta"]);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.alpha).toEqual({ command: "a" });
    expect(config.mcpServers?.gamma).toEqual({ command: "c" });
    expect(config.mcpServers?.beta).toBeUndefined();
  });
});
