/**
 * Mail event adapter for the unified monitor event stream.
 *
 * Publishes mail lifecycle events to the EventBus. Kept separate from
 * ipc-server.ts to avoid merge conflicts with #1511 (GET /events endpoint).
 *
 * Usage: call publishMailSent() from the sendMail / replyToMail handlers.
 *
 * #1512
 */

import { MAIL_SENT, type MonitorEventInput } from "@mcp-cli/core";
import type { EventBus } from "./event-bus";

export function publishMailSent(
  eventBus: EventBus | null,
  opts: {
    mailId: number;
    sender: string;
    recipient: string;
    /** The partition the message was delivered into. Required — see #3038. */
    domainId: number;
    /**
     * The resolved domain's name. Always present — partition 0 is a named partition
     * (`UNASSIGNED_DOMAIN_NAME`, `_`), not a nameless carve-out; see #3038.
     */
    domain: string;
  },
): void {
  if (!eventBus) return;
  const input: MonitorEventInput = {
    src: "daemon.mail",
    event: MAIL_SENT,
    category: "mail",
    mailId: opts.mailId,
    sender: opts.sender,
    recipient: opts.recipient,
    // Carried on every mail event so a monitor consumer can filter by partition without
    // a second lookup.
    domainId: opts.domainId,
    domain: opts.domain,
  };
  eventBus.publish(input);
}
