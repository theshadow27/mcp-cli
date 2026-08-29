import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMethod } from "@mcp-cli/core";
import { McxDb } from "../db/state";
import type { RequestHandler } from "../handler-types";
import { SiteWatchHandlers } from "./site-watch";

const paths: string[] = [];
function openDb(): McxDb {
  const p = join(tmpdir(), `mcp-cli-swh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return new McxDb(p);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
        // dotw-ignore test-empty-catch: best-effort cleanup
      } catch {
        // ignore
      }
    }
  }
});

function register(db: McxDb): Map<IpcMethod, RequestHandler> {
  const handlers = new Map<IpcMethod, RequestHandler>();
  new SiteWatchHandlers(db).register(handlers);
  return handlers;
}

const ctx = {} as Parameters<RequestHandler>[1];

describe("SiteWatchHandlers", () => {
  test("get returns null before any set", async () => {
    const db = openDb();
    const handlers = register(db);
    const res = await handlers.get("siteWatchCursorGet")?.({ site: "teams", thread: "19:a@thread.v2" }, ctx);
    expect(res).toEqual({ lastVersion: null });
    db.close();
  });

  test("set then get round-trips through the db", async () => {
    const db = openDb();
    const handlers = register(db);
    const setRes = await handlers.get("siteWatchCursorSet")?.(
      { site: "teams", thread: "19:a@thread.v2", lastVersion: "1700000000001" },
      ctx,
    );
    expect(setRes).toEqual({ ok: true });
    const getRes = await handlers.get("siteWatchCursorGet")?.({ site: "teams", thread: "19:a@thread.v2" }, ctx);
    expect(getRes).toEqual({ lastVersion: "1700000000001" });
    expect(db.getSiteWatchCursor("teams", "19:a@thread.v2")).toBe("1700000000001");
    db.close();
  });

  test("rejects a malformed set (missing lastVersion)", async () => {
    const db = openDb();
    const handlers = register(db);
    await expect(
      handlers.get("siteWatchCursorSet")?.({ site: "teams", thread: "19:a@thread.v2" }, ctx),
    ).rejects.toThrow();
    db.close();
  });
});
