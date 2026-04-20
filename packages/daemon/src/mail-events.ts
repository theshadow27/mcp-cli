/**
 * Mail event adapter for the unified monitor event stream.
 *
 * Publishes mail lifecycle events to the EventBus. Kept separate from
 * ipc-server.ts to avoid merge conflicts with #1511 (GET /events endpoint).
 *
 * Usage: call publishMailEvent() from the sendMail / replyToMail handlers.
 *
 * #1512
 */

import { MAIL_RECEIVED, type MonitorEventInput } from "@mcp-cli/core";
import type { EventBus } from "./event-bus";

export function publishMailReceived(
  eventBus: EventBus | null,
  opts: { mailId: number; sender: string; recipient: string },
): void {
  if (!eventBus) return;
  const input: MonitorEventInput = {
    src: "daemon.mail",
    event: MAIL_RECEIVED,
    category: "mail",
    mailId: opts.mailId,
    sender: opts.sender,
    recipient: opts.recipient,
  };
  eventBus.publish(input);
}
