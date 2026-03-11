import { ipcCall } from "@mcp-cli/core";
import { useEffect, useState } from "react";

interface UseUnreadMailResult {
  unreadCount: number;
}

export interface UseUnreadMailOptions {
  /** Gate polling — when false, the effect is a no-op. */
  enabled?: boolean;
  intervalMs?: number;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useUnreadMail(opts: UseUnreadMailOptions = {}): UseUnreadMailResult {
  const { enabled = true, intervalMs = 10_000, ipcCallFn = ipcCall } = opts;
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, intervalMs, ipcCallFn]);

  return { unreadCount };
}
