import { type MailMessage, ProtocolMismatchError } from "@mcp-cli/core";

/** Error codes considered transient — daemon blips, socket churn, restart races. */
const TRANSIENT_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EAGAIN", "ENOTCONN", "ENOENT"]);

/** Warn after this many consecutive transient failures (~20s at 2s interval). */
const TRANSIENT_WARN_THRESHOLD = 10;

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
  // Some IPC paths surface the code only in the message string.
  for (const c of TRANSIENT_ERROR_CODES) {
    // dotw-todo no-error-message-sniffing: fix IPC to expose structured code; use getErrorCode() — fix in #2264
    if (err.message.includes(c)) return true;
  }
  return false;
}

/**
 * Poll for unread mail addressed to `recipient` until one arrives or the
 * deadline expires. Non-consuming — does not markRead, so the caller can
 * still read the message via `mcx mail -u <recipient>` afterward.
 *
 * `afterMs` is a `Date.now()` snapshot taken before polling begins. Only
 * mail with `createdAt` strictly after that timestamp is surfaced, so
 * pre-existing unread messages do not cause false-positive wakeups.
 *
 * Transient `pollMail` errors (IPC blips, daemon restart, socket churn) are
 * swallowed and retried until the deadline. `ProtocolMismatchError` and
 * unknown errors propagate so callers fail fast instead of spin-polling
 * for the full timeout against an unrecoverable condition.
 *
 * Returns the message, or null on timeout.
 */
export async function pollMailUntil(
  d: { pollMail: (recipient: string) => Promise<MailMessage | null> },
  recipient: string,
  timeoutMs: number,
  afterMs: number,
  pollIntervalMs = 2000,
  signal?: AbortSignal,
): Promise<MailMessage | null> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveTransient = 0;
  let warnedTransient = false;
  let warnedNaN = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    let msg: MailMessage | null = null;
    try {
      msg = await d.pollMail(recipient);
      consecutiveTransient = 0;
    } catch (err) {
      if (err instanceof ProtocolMismatchError) throw err;
      if (!isTransientError(err)) throw err;
      consecutiveTransient++;
      if (consecutiveTransient >= TRANSIENT_WARN_THRESHOLD && !warnedTransient) {
        warnedTransient = true;
        console.error(
          `[mail-wait] ${consecutiveTransient} consecutive transient IPC errors polling for ${recipient}; last: ${(err as Error).message}`,
        );
      }
    }
    if (msg) {
      const createdMs = new Date(msg.createdAt).getTime();
      if (!Number.isFinite(createdMs)) {
        if (!warnedNaN) {
          warnedNaN = true;
          console.error(
            `[mail-wait] mail id=${msg.id} for ${recipient} has invalid createdAt=${JSON.stringify(msg.createdAt)}; ignoring`,
          );
        }
      } else if (createdMs > afterMs) {
        return msg;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (signal?.aborted) return null;
    await Bun.sleep(Math.min(pollIntervalMs, remaining));
  }
  return null;
}

export function emitMailEvent(
  msg: MailMessage,
  short: boolean,
  d: { log: (...args: unknown[]) => void },
  includeHeader = false,
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
