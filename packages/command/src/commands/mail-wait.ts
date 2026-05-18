import type { MailMessage } from "@mcp-cli/core";

/**
 * Poll for unread mail addressed to `recipient` until one arrives or the
 * deadline expires. Non-consuming — does not markRead, so the caller can
 * still read the message via `mcx mail -u <recipient>` afterward.
 *
 * `afterMs` is a `Date.now()` snapshot taken before polling begins. Only
 * mail with `createdAt` strictly after that timestamp is surfaced, so
 * pre-existing unread messages do not cause false-positive wakeups.
 *
 * Transient `pollMail` errors (IPC blips, daemon restart) are swallowed
 * and retried until the deadline; a single network hiccup will not kill
 * the entire wait.
 *
 * Returns the message, or null on timeout.
 */
export async function pollMailUntil(
  d: { pollMail: (recipient: string) => Promise<MailMessage | null> },
  recipient: string,
  timeoutMs: number,
  afterMs: number,
  pollIntervalMs = 2000,
): Promise<MailMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let msg: MailMessage | null = null;
    try {
      msg = await d.pollMail(recipient);
    } catch {
      // Transient IPC error — continue polling until deadline
    }
    if (msg && new Date(msg.createdAt).getTime() > afterMs) return msg;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(pollIntervalMs, remaining));
  }
  return null;
}

export function emitMailEvent(
  msg: MailMessage,
  short: boolean,
  d: { log: (...args: unknown[]) => void },
  includeHeader = true,
): void {
  if (short) {
    const subj = msg.subject ?? "(no subject)";
    d.log(`mail ${msg.id} ${msg.sender} ${subj}`);
    return;
  }
  if (includeHeader) {
    const headerParts = ["event=mail", `id=${msg.id}`];
    if (msg.sender) headerParts.push(`sender=${msg.sender}`);
    d.log(headerParts.join(" ").slice(0, 120));
  }
  d.log(JSON.stringify({ source: "mail", mail: msg }, null, 2));
}
