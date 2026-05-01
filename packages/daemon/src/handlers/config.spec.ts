import { describe, expect, test } from "bun:test";
import type { IpcMethod, ResolvedConfig } from "@mcp-cli/core";
import { IPC_ERROR } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { ConfigHandlers } from "./config";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockPool(servers: { name: string; transport: string; toolCount: number }[] = []) {
  return {
    listServers: () => servers,
  } as never;
}

function mockConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: new Map(),
    sources: [],
    ...overrides,
  };
}

function buildHandlers(
  pool = mockPool(),
  config = mockConfig(),
  onReload: (() => Promise<void>) | null = null,
): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new ConfigHandlers(pool, config, onReload).register(map);
  return map;
}

describe("ConfigHandlers", () => {
  test("getConfig returns empty servers when config has no servers", async () => {
    const map = buildHandlers();
    const result = (await invoke(map, "getConfig")(undefined, {} as never)) as {
      servers: Record<string, unknown>;
      sources: unknown[];
    };
    expect(result.servers).toEqual({});
    expect(result.sources).toEqual([]);
  });

  test("getConfig merges pool status into server entries", async () => {
    const config = mockConfig({
      servers: new Map([
        [
          "my-server",
          {
            name: "my-server",
            config: { command: "npx", args: [] },
            source: { file: "/home/user/.claude.json", scope: "user" },
          },
        ],
      ]),
      sources: [{ file: "/home/user/.claude.json", scope: "user" as const }],
    });
    const pool = mockPool([{ name: "my-server", transport: "stdio", toolCount: 5 }]);
    const map = buildHandlers(pool, config);
    const result = (await invoke(map, "getConfig")(undefined, {} as never)) as {
      servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }>;
      sources: unknown[];
    };
    expect(result.servers["my-server"]).toEqual({
      transport: "stdio",
      source: "/home/user/.claude.json",
      scope: "user",
      toolCount: 5,
    });
    expect(result.sources).toHaveLength(1);
  });

  test("getConfig uses unknown transport and 0 toolCount when server not in pool", async () => {
    const config = mockConfig({
      servers: new Map([
        [
          "offline-server",
          {
            name: "offline-server",
            config: { command: "npx", args: [] },
            source: { file: "/etc/mcp.json", scope: "project" },
          },
        ],
      ]),
    });
    const map = buildHandlers(mockPool([]), config);
    const result = (await invoke(map, "getConfig")(undefined, {} as never)) as {
      servers: Record<string, { transport: string; toolCount: number }>;
    };
    expect(result.servers["offline-server"].transport).toBe("unknown");
    expect(result.servers["offline-server"].toolCount).toBe(0);
  });

  test("reloadConfig calls onReloadConfig and returns ok", async () => {
    let called = false;
    const map = buildHandlers(mockPool(), mockConfig(), async () => {
      called = true;
    });
    const result = (await invoke(map, "reloadConfig")(undefined, {} as never)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(called).toBe(true);
  });

  test("reloadConfig throws INTERNAL_ERROR when no reload fn", async () => {
    const map = buildHandlers(mockPool(), mockConfig(), null);
    await expect(invoke(map, "reloadConfig")(undefined, {} as never)).rejects.toMatchObject({
      code: IPC_ERROR.INTERNAL_ERROR,
    });
  });
});
