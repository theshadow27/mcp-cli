import { ipcCall } from "@mcp-cli/core";
import { useEffect, useState } from "react";

interface UseUnreadMailResult {
  unreadCount: number;
}

export interface UseUnreadMailOptions {
  intervalMs?: number;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useUnreadMail(opts: UseUnreadMailOptions = {}): UseUnreadMailResult {
  const { intervalMs = 10_000, ipcCallFn = ipcCall } = opts;
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const result = await ipcCallFn("readMail", { unreadOnly: true });
        if (!cancelled) {
          setUnreadCount(result.messages.length);
        }
      } catch {
        // Silently ignore — badge just won't update
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function scheduleNext() {
      await poll();
      if (!cancelled) {
        timerId = setTimeout(scheduleNext, intervalMs);
      }
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [intervalMs, ipcCallFn]);

  return { unreadCount };
}
