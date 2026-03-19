import { describe, expect, test } from "bun:test";
import type { IpcMethod, IpcMethodResult, NoteEntry } from "@mcp-cli/core";
import type { NoteDeps } from "./note";
import { cmdNote } from "./note";

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function makeDeps(overrides: Partial<Record<IpcMethod, unknown>> = {}): NoteDeps {
  return {
    ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
      if (method in overrides) {
        const fn = overrides[method];
        return (typeof fn === "function" ? fn(params) : fn) as IpcMethodResult[M];
      }
      throw new Error(`Unexpected IPC call: ${method}`);
    },
    exit: (code: number): never => {
      throw new ExitError(code);
    },
  };
}

describe("cmdNote", () => {
  // -- set --
  test("set calls setNote IPC with joined note text", async () => {
    let captured: unknown;
    const deps = makeDeps({
      setNote: (params: unknown) => {
        captured = params;
        return { ok: true };
      },
    });

    await cmdNote(["set", "atlassian.editJiraIssue", "use", "categoryId", "37"], deps);
    expect(captured).toEqual({ server: "atlassian", tool: "editJiraIssue", note: "use categoryId 37" });
  });

  test("set rejects missing key", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["set"], deps)).rejects.toThrow("exit(1)");
  });

  test("set rejects missing note text", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["set", "srv.tool"], deps)).rejects.toThrow("exit(1)");
  });

  test("set rejects invalid key (no dot)", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["set", "noperiod", "some note"], deps)).rejects.toThrow("exit(1)");
  });

  test("set rejects key starting with dot", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["set", ".tool", "note"], deps)).rejects.toThrow("exit(1)");
  });

  test("set rejects key ending with dot", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["set", "server.", "note"], deps)).rejects.toThrow("exit(1)");
  });

  // -- get --
  test("get returns note text", async () => {
    const deps = makeDeps({
      getNote: { note: "my note" },
    });
    await cmdNote(["get", "atlassian.editJiraIssue"], deps);
  });

  test("get handles missing note", async () => {
    const deps = makeDeps({
      getNote: { note: null },
    });
    await cmdNote(["get", "atlassian.editJiraIssue"], deps);
  });

  test("get rejects missing key", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["get"], deps)).rejects.toThrow("exit(1)");
  });

  test("get rejects invalid key", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["get", "badkey"], deps)).rejects.toThrow("exit(1)");
  });

  // -- ls --
  test("ls lists all notes", async () => {
    const notes: NoteEntry[] = [
      { serverName: "atlassian", toolName: "editJiraIssue", note: "use categoryId 37", updatedAt: 1700000000 },
    ];
    const deps = makeDeps({ listNotes: notes });
    await cmdNote(["ls"], deps);
  });

  test("ls handles empty list", async () => {
    const deps = makeDeps({ listNotes: [] });
    await cmdNote(["ls"], deps);
  });

  test("list is alias for ls", async () => {
    const deps = makeDeps({ listNotes: [] });
    await cmdNote(["list"], deps);
  });

  // -- rm --
  test("rm calls deleteNote IPC", async () => {
    let captured: unknown;
    const deps = makeDeps({
      deleteNote: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdNote(["rm", "atlassian.editJiraIssue"], deps);
    expect(captured).toEqual({ server: "atlassian", tool: "editJiraIssue" });
  });

  test("rm handles not-found", async () => {
    const deps = makeDeps({
      deleteNote: { ok: true, deleted: false },
    });
    await cmdNote(["rm", "srv.tool"], deps);
  });

  test("remove is alias for rm", async () => {
    const deps = makeDeps({
      deleteNote: { ok: true, deleted: true },
    });
    await cmdNote(["remove", "srv.tool"], deps);
  });

  test("delete is alias for rm", async () => {
    const deps = makeDeps({
      deleteNote: { ok: true, deleted: true },
    });
    await cmdNote(["delete", "srv.tool"], deps);
  });

  test("rm rejects missing key", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["rm"], deps)).rejects.toThrow("exit(1)");
  });

  test("rm rejects invalid key", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["rm", "badkey"], deps)).rejects.toThrow("exit(1)");
  });

  // -- help and unknown --
  test("no args shows help", async () => {
    const deps = makeDeps();
    await cmdNote([], deps);
  });

  test("--help shows help", async () => {
    const deps = makeDeps();
    await cmdNote(["--help"], deps);
  });

  test("-h shows help", async () => {
    const deps = makeDeps();
    await cmdNote(["-h"], deps);
  });

  test("unknown subcommand exits with error", async () => {
    const deps = makeDeps();
    await expect(cmdNote(["bogus"], deps)).rejects.toThrow("exit(1)");
  });
});
