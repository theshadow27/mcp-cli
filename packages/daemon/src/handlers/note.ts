import { DeleteNoteParamsSchema, GetNoteParamsSchema, SetNoteParamsSchema } from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

export class NoteHandlers {
  constructor(private db: StateDb) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("setNote", async (params) => {
      const { server, tool, note } = SetNoteParamsSchema.parse(params);
      this.db.setNote(server, tool, note);
      return { ok: true as const };
    });
    handlers.set("getNote", async (params) => {
      const { server, tool } = GetNoteParamsSchema.parse(params);
      const note = this.db.getNote(server, tool);
      return { note: note ?? null };
    });
    handlers.set("listNotes", async () => this.db.listNotes());
    handlers.set("deleteNote", async (params) => {
      const { server, tool } = DeleteNoteParamsSchema.parse(params);
      const deleted = this.db.deleteNote(server, tool);
      return { ok: true as const, deleted };
    });
  }
}
