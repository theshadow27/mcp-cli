import {
  IPC_ERROR,
  MarkReadParamsSchema,
  ReadMailParamsSchema,
  ReplyToMailParamsSchema,
  SendMailParamsSchema,
  WaitForMailParamsSchema,
} from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { EventBus } from "../event-bus";
import type { RequestHandler } from "../handler-types";
import { publishMailReceived } from "../mail-events";

export class MailHandlers {
  constructor(
    private readonly db: StateDb,
    private readonly eventBus: EventBus | null,
    private readonly isDraining: () => boolean,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("sendMail", async (params, _ctx) => {
      const { sender, recipient, subject, body, replyTo } = SendMailParamsSchema.parse(params);
      const id = this.db.insertMail(sender, recipient, subject, body, replyTo);
      publishMailReceived(this.eventBus, { mailId: id, sender, recipient });
      return { id };
    });

    handlers.set("readMail", async (params, _ctx) => {
      const { recipient, unreadOnly, limit } = ReadMailParamsSchema.parse(params ?? {});
      const messages = this.db.readMail(recipient, unreadOnly, limit);
      return { messages };
    });

    handlers.set("waitForMail", async (params, _ctx) => {
      const { recipient, timeout } = WaitForMailParamsSchema.parse(params ?? {});
      // Server-side timeout capped at 30s to stay under IPC client's 60s timeout
      const maxWait = Math.min((timeout ?? 30) * 1000, 30_000);
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline) {
        if (this.isDraining()) return { message: null };
        const msg = this.db.getNextUnread(recipient);
        if (msg) {
          this.db.markMailRead(msg.id);
          return { message: msg };
        }
        await Bun.sleep(500);
      }
      return { message: null };
    });

    handlers.set("replyToMail", async (params, _ctx) => {
      const { id, sender, body, subject } = ReplyToMailParamsSchema.parse(params);
      const original = this.db.getMailById(id);
      if (!original) {
        throw Object.assign(new Error(`Mail message ${id} not found`), {
          code: IPC_ERROR.INVALID_PARAMS,
        });
      }
      const replySubject = subject ?? (original.subject ? `Re: ${original.subject}` : undefined);
      const newId = this.db.insertMail(sender, original.sender, replySubject, body, id);
      publishMailReceived(this.eventBus, { mailId: newId, sender, recipient: original.sender });
      return { id: newId };
    });

    handlers.set("markRead", async (params, _ctx) => {
      const { id } = MarkReadParamsSchema.parse(params);
      this.db.markMailRead(id);
      return {};
    });
  }
}
