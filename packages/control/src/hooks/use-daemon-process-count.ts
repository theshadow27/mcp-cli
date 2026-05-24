import { spawnCapture } from "@mcp-cli/core";
import { useEffect, useState } from "react";

export interface UseDaemonProcessCountOptions {
  /** Polling interval in ms (default: 5000). */
  intervalMs?: number;
  /** Override for testing — returns the process count. */
  countFn?: () => Promise<number>;
}

/** Count running mcpd processes via pgrep. */
export async function countDaemonProcesses(): Promise<number> {
  try {
    const result = await spawnCapture("pgrep", ["-x", "mcpd"]);
    // Each line is a PID; empty output = 0 processes
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    return lines.length;
  } catch {
    return 0;
  }
}

export function useDaemonProcessCount(opts: UseDaemonProcessCountOptions = {}): number {
  const { intervalMs = 5000, countFn = countDaemonProcesses } = opts;
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const n = await countFn();
      if (!cancelled) setCount(n);
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
  }, [intervalMs, countFn]);

  return count;
}
