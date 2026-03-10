import type { MetricsSnapshot } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useEffect, useState } from "react";

export interface UseMetricsResult {
  metrics: MetricsSnapshot | null;
  error: string | null;
  loading: boolean;
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

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function poll() {
      try {
        const result = await ipcCallFn("getMetrics");
        if (!cancelled) {
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

  return { metrics, error, loading };
}
