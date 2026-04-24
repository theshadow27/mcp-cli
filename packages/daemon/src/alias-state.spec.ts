import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcResponse } from "@mcp-cli/core";
import { silentLogger } from "@mcp-cli/core";
import { installDaemonLogCapture } from "./daemon-log";
import { StateDb } from "./db/state";
import { IpcServer } from "./ipc-server";

installDaemonLogCapture();

function tmpSocket(): string {
  return join(tmpdir(), `mcp-alias-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function tmpDbPath(): string {
  return join(tmpdir(), `mcp-alias-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(p: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(p + suffix);
    } catch {
      /* ignore */
    }
  }
}

function mockPool() {
  return {
    listServers: () => [],
    listTools: () => [],
    getToolInfo: () => null,
    grepTools: () => [],
    callTool: async () => ({ content: [] }),
    getServerUrl: () => null,
    getDb: () => null,
    restart: async () => {},
    getStderrLines: () => [],
    subscribeStderr: () => () => {},
  };
}

function mockConfig() {
  return { servers: new Map(), sources: [] } as never;
}

function serverOpts() {
  return {
    daemonId: "test-alias-state-daemon",
    startedAt: Date.now(),
    onActivity: () => {},
    logger: silentLogger,
  };
}

describe("aliasState IPC handlers — repoRoot canonicalization", () => {
  let server: IpcServer | undefined;
  let socketPath: string;
  let db: StateDb | undefined;
  let dbPath: string;

  afterEach(() => {
    server?.stop();
    server = undefined;
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    db?.close();
    db = undefined;
    cleanupDb(dbPath);
  });

  function start(): { rpc: (body: unknown) => Promise<IpcResponse> } {
    dbPath = tmpDbPath();
    db = new StateDb(dbPath);
    socketPath = tmpSocket();
    server = new IpcServer(mockPool() as never, mockConfig(), db, null, serverOpts());
    server.start(socketPath);

    async function rpc(body: unknown): Promise<IpcResponse> {
      const res = await fetch("http://localhost/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        unix: socketPath,
      } as RequestInit);
      return res.json() as Promise<IpcResponse>;
    }

    return { rpc };
  }

  test("aliasStateSet then aliasStateGet round-trips a value", async () => {
    const { rpc } = start();

    const setResp = await rpc({
      id: "s1",
      method: "aliasStateSet",
      params: { repoRoot: "/test/repo", namespace: "ns1", key: "session", value: "abc" },
    });
    expect(setResp.error).toBeUndefined();
    expect((setResp.result as { ok: boolean }).ok).toBe(true);

    const getResp = await rpc({
      id: "g1",
      method: "aliasStateGet",
      params: { repoRoot: "/test/repo", namespace: "ns1", key: "session" },
    });
    expect(getResp.error).toBeUndefined();
    expect((getResp.result as { value: unknown }).value).toBe("abc");
  });

  test("trailing slash on set is canonicalized — get without slash returns the value", async () => {
    const { rpc } = start();

    await rpc({
      id: "s2",
      method: "aliasStateSet",
      params: { repoRoot: "/test/repo/path/", namespace: "ns2", key: "k", value: "v" },
    });

    const getResp = await rpc({
      id: "g2",
      method: "aliasStateGet",
      params: { repoRoot: "/test/repo/path", namespace: "ns2", key: "k" },
    });
    expect(getResp.error).toBeUndefined();
    expect((getResp.result as { value: unknown }).value).toBe("v");
  });

  test("trailing slash on get is canonicalized — set without slash, get with slash returns the value", async () => {
    const { rpc } = start();

    await rpc({
      id: "s3",
      method: "aliasStateSet",
      params: { repoRoot: "/test/repo/path", namespace: "ns3", key: "k", value: "v2" },
    });

    const getResp = await rpc({
      id: "g3",
      method: "aliasStateGet",
      params: { repoRoot: "/test/repo/path/", namespace: "ns3", key: "k" },
    });
    expect(getResp.error).toBeUndefined();
    expect((getResp.result as { value: unknown }).value).toBe("v2");
  });

  test("aliasStateDelete removes the entry", async () => {
    const { rpc } = start();

    await rpc({
      id: "s4",
      method: "aliasStateSet",
      params: { repoRoot: "/test/repo", namespace: "ns4", key: "del-me", value: 42 },
    });

    const delResp = await rpc({
      id: "d1",
      method: "aliasStateDelete",
      params: { repoRoot: "/test/repo", namespace: "ns4", key: "del-me" },
    });
    expect(delResp.error).toBeUndefined();
    expect((delResp.result as { deleted: boolean }).deleted).toBe(true);

    const getResp = await rpc({
      id: "g4",
      method: "aliasStateGet",
      params: { repoRoot: "/test/repo", namespace: "ns4", key: "del-me" },
    });
    expect((getResp.result as { value: unknown }).value).toBeUndefined();
  });

  test("aliasStateAll lists all entries for namespace", async () => {
    const { rpc } = start();

    await rpc({
      id: "s5a",
      method: "aliasStateSet",
      params: { repoRoot: "/repo", namespace: "ns5", key: "a", value: 1 },
    });
    await rpc({
      id: "s5b",
      method: "aliasStateSet",
      params: { repoRoot: "/repo", namespace: "ns5", key: "b", value: 2 },
    });

    const allResp = await rpc({ id: "a1", method: "aliasStateAll", params: { repoRoot: "/repo/", namespace: "ns5" } });
    expect(allResp.error).toBeUndefined();
    const entries = (allResp.result as { entries: Record<string, unknown> }).entries;
    expect(entries.a).toBe(1);
    expect(entries.b).toBe(2);
  });

  test("symlink repoRoot is canonicalized — symlink and real path resolve to same row", async () => {
    const { rpc } = start();
    const base = mkdtempSync(join(tmpdir(), "mcp-alias-state-symlink-"));
    const real = join(base, "real-repo");
    const link = join(base, "link-repo");
    mkdirSync(real);
    symlinkSync(real, link);

    try {
      await rpc({
        id: "sym-set",
        method: "aliasStateSet",
        params: { repoRoot: link, namespace: "sym-ns", key: "k", value: "symval" },
      });

      const getResp = await rpc({
        id: "sym-get",
        method: "aliasStateGet",
        params: { repoRoot: real, namespace: "sym-ns", key: "k" },
      });
      expect(getResp.error).toBeUndefined();
      expect((getResp.result as { value: unknown }).value).toBe("symval");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("symlink repoRoot is canonicalized — real path and symlink resolve to same row (inverse)", async () => {
    const { rpc } = start();
    const base = mkdtempSync(join(tmpdir(), "mcp-alias-state-symlink-inv-"));
    const real = join(base, "real-repo");
    const link = join(base, "link-repo");
    mkdirSync(real);
    symlinkSync(real, link);

    try {
      await rpc({
        id: "inv-set",
        method: "aliasStateSet",
        params: { repoRoot: real, namespace: "inv-ns", key: "k", value: "realval" },
      });

      const getResp = await rpc({
        id: "inv-get",
        method: "aliasStateGet",
        params: { repoRoot: link, namespace: "inv-ns", key: "k" },
      });
      expect(getResp.error).toBeUndefined();
      expect((getResp.result as { value: unknown }).value).toBe("realval");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("empty repoRoot is rejected by Zod schema — returns IPC error", async () => {
    const { rpc } = start();

    const resp = await rpc({
      id: "e1",
      method: "aliasStateGet",
      params: { repoRoot: "", namespace: "ns", key: "k" },
    });
    expect(resp.error).toBeDefined();
  });
});
