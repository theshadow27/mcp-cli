import { describe, expect, test } from "bun:test";
import type { IpcMethod } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { NoteHandlers } from "./note";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockDb(overrides: Record<string, unknown> = {}) {
  const notes = new Map<string, string>();
  return {
    setNote: (server: string, tool: string, note: string) => {
      notes.set(`${server}\0${tool}`, note);
    },
    getNote: (server: string, tool: string) => notes.get(`${server}\0${tool}`) ?? null,
    listNotes: () => [],
    deleteNote: () => false,
    ...overrides,
  } as never;
}

function buildHandlers(db = mockDb()): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new NoteHandlers(db).register(map);
  return map;
}

describe("NoteHandlers", () => {
  test("setNote then getNote returns note", async () => {
    const map = buildHandlers();
    await invoke(map, "setNote")({ server: "s1", tool: "t1", note: "hello" }, {} as never);
    const result = (await invoke(map, "getNote")({ server: "s1", tool: "t1" }, {} as never)) as { note: string | null };
    expect(result.note).toBe("hello");
  });

  test("getNote returns null for unknown tool", async () => {
    const map = buildHandlers();
    const result = (await invoke(map, "getNote")({ server: "s1", tool: "missing" }, {} as never)) as {
      note: string | null;
    };
    expect(result.note).toBeNull();
  });

  test("listNotes delegates to db", async () => {
    const notes = [{ serverName: "s1", toolName: "t1", note: "hi" }];
    const map = buildHandlers(mockDb({ listNotes: () => notes }));
    const result = await invoke(map, "listNotes")(undefined, {} as never);
    expect(result).toEqual(notes);
  });

  test("deleteNote returns ok with deleted flag", async () => {
    const map = buildHandlers(mockDb({ deleteNote: () => true }));
    const result = (await invoke(map, "deleteNote")({ server: "s1", tool: "t1" }, {} as never)) as {
      ok: boolean;
      deleted: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
  });
});
