import type { MailMessage } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 3000;
const MAX_MESSAGES = 200;

export interface UseMailResult {
  messages: MailMessage[];
}

export interface UseMailOptions {
  /** Gate polling — when false, the effect is a no-op. */
  enabled?: boolean;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useMail(opts: UseMailOptions = {}): UseMailResult {
  const { enabled = true, ipcCallFn = ipcCall } = opts;
  const [messages, setMessages] = useState<MailMessage[]>([]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const result = await ipcCallFn("readMail", { limit: MAX_MESSAGES, recipient: "human" });
        if (!cancelled) {
          setMessages(result.messages);
        }
      } catch {
        // Daemon unreachable — skip this tick
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function scheduleNext() {
      await poll();
      if (!cancelled) {
        timerId = setTimeout(scheduleNext, POLL_INTERVAL_MS);
      }
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [enabled, ipcCallFn]);

  return { messages };
}
