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
import { resolveCallerDomain, resolveDelivery } from "../mail-domain";
import { publishMailSent } from "../mail-events";

/**
 * Mail IPC handlers. All five are domain-scoped (#3038).
 *
 * Each resolves the caller's partition **before** touching the DB, via
 * `resolveCallerDomain`, which throws rather than guessing. Reads then pass that
 * partition into `StateDb`, whose mail methods require it as their first parameter —
 * so there is no handler here that can read or write without having named a partition.
 */
export class MailHandlers {
  constructor(
    private readonly db: StateDb,
    private readonly eventBus: EventBus | null,
    private readonly isDraining: () => boolean,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("sendMail", async (params, _ctx) => {
      const { sender, recipient, subject, body, replyTo, cwd, domain } = SendMailParamsSchema.parse(params);
      const caller = resolveCallerDomain(this.db, { cwd, domain });
      const delivery = resolveDelivery(this.db, caller, sender, recipient);
      const id = this.db.insertMail(delivery.domain.id, delivery.sender, delivery.recipient, subject, body, replyTo);
      publishMailSent(this.eventBus, {
        mailId: id,
        sender: delivery.sender,
        recipient: delivery.recipient,
        domainId: delivery.domain.id,
        domain: delivery.domain.name,
      });
      return { id };
    });

    handlers.set("readMail", async (params, _ctx) => {
      const { recipient, unreadOnly, limit, cwd, domain } = ReadMailParamsSchema.parse(params ?? {});
      const caller = resolveCallerDomain(this.db, { cwd, domain });
      const messages = this.db.readMail(caller.id, recipient, unreadOnly, limit);
      return { messages, domain: caller.name };
    });

    handlers.set("waitForMail", async (params, _ctx) => {
      const { recipient, timeout, cwd, domain } = WaitForMailParamsSchema.parse(params ?? {});
      // Resolved once, before the poll loop: the caller's partition cannot change
      // mid-wait, and re-resolving per tick would realpath() twice a second.
      const caller = resolveCallerDomain(this.db, { cwd, domain });
      // Server-side timeout capped at 30s to stay under IPC client's 60s timeout
      const maxWait = Math.min((timeout ?? 30) * 1000, 30_000);
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline) {
        if (this.isDraining()) return { message: null, domain: caller.name };
        const msg = this.db.getNextUnread(caller.id, recipient);
        if (msg) {
          this.db.markMailRead(msg.id, caller.id);
          return { message: msg, domain: caller.name };
        }
        await Bun.sleep(500);
      }
      return { message: null, domain: caller.name };
    });

    handlers.set("replyToMail", async (params, _ctx) => {
      const { id, sender, body, subject, cwd, domain } = ReplyToMailParamsSchema.parse(params);
      const caller = resolveCallerDomain(this.db, { cwd, domain });
      // Scoped lookup: an id belonging to another domain reads as not-found, so a reply
      // can never quote or thread onto a message the caller was never shown.
      const original = this.db.getMailById(id, caller.id);
      if (!original) {
        throw Object.assign(new Error(`Mail message ${id} not found`), {
          code: IPC_ERROR.INVALID_PARAMS,
        });
      }
      const replySubject = subject ?? (original.subject ? `Re: ${original.subject}` : undefined);
      // `original.sender` is qualified `user@domain` when the message crossed a boundary,
      // so this routes the reply back to where it came from rather than to a same-named
      // mailbox in the caller's own domain.
      const delivery = resolveDelivery(this.db, caller, sender, original.sender);
      const newId = this.db.insertMail(delivery.domain.id, delivery.sender, delivery.recipient, replySubject, body, id);
      publishMailSent(this.eventBus, {
        mailId: newId,
        sender: delivery.sender,
        recipient: delivery.recipient,
        domainId: delivery.domain.id,
        domain: delivery.domain.name,
      });
      return { id: newId };
    });

    handlers.set("markRead", async (params, _ctx) => {
      const { id, cwd, domain } = MarkReadParamsSchema.parse(params);
      const caller = resolveCallerDomain(this.db, { cwd, domain });
      // The return value is the partition check. Discarding it made a cross-partition
      // mark-read report success — the caller was told it had consumed a message it was
      // never allowed to see, and the real owner's message stayed unread with no trace.
      // `changes = 0` means "not in this partition, or not there at all": re-marking an
      // already-read message in your OWN partition still reports 1, so this cannot
      // misfire on an idempotent re-mark. Same shape as replyToMail above.
      if (!this.db.markMailRead(id, caller.id)) {
        throw Object.assign(new Error(`Mail message ${id} not found`), {
          code: IPC_ERROR.INVALID_PARAMS,
        });
      }
      return {};
    });
  }
}
