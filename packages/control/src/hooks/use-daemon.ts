import type { DaemonStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useCallback, useEffect, useState } from "react";
import { checkProtocolVersion } from "./protocol-check";

interface UseDaemonResult {
  status: DaemonStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export interface UseDaemonOptions {
  intervalMs?: number;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useDaemon(opts: UseDaemonOptions = {}): UseDaemonResult {
  const { intervalMs = 2500, ipcCallFn = ipcCall } = opts;
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick triggers re-poll on refresh()
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const result = await ipcCallFn("status");
        if (!cancelled) {
          const mismatch = checkProtocolVersion(result.protocolVersion);
          if (mismatch) {
            console.error(mismatch);
            process.exit(2);
          }
          setStatus(result);
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
  }, [intervalMs, ipcCallFn, tick]);

  return { status, error, loading, refresh };
}
