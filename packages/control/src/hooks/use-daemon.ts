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

export function useDaemon(intervalMs = 2500): UseDaemonResult {
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
        const result = await ipcCall("status");
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

    poll();
    const id = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, tick]);

  return { status, error, loading, refresh };
}
