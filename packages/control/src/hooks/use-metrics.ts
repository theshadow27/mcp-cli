import type { MetricsSnapshot } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useEffect, useRef, useState } from "react";

export interface UseMetricsResult {
  metrics: MetricsSnapshot | null;
  error: string | null;
  loading: boolean;
  /** Timestamp (ms) when a daemon restart was detected, or null if no restart seen. */
  restartedAt: number | null;
}

export interface UseMetricsOptions {
  intervalMs?: number;
  enabled?: boolean;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useMetrics(opts: UseMetricsOptions = {}): UseMetricsResult {
  const { intervalMs = 3000, enabled = true, ipcCallFn = ipcCall } = opts;
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restartedAt, setRestartedAt] = useState<number | null>(null);
  const prevDaemonIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function poll() {
      try {
        const result = await ipcCallFn("getMetrics");
        if (!cancelled) {
          // Detect daemon restart by comparing daemonId
          if (result.daemonId) {
            const prev = prevDaemonIdRef.current;
            if (prev !== null && prev !== result.daemonId) {
              setRestartedAt(Date.now());
            }
            prevDaemonIdRef.current = result.daemonId;
          }
          setMetrics(result);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
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
  }, [intervalMs, enabled, ipcCallFn]);

  return { metrics, error, loading, restartedAt };
}
