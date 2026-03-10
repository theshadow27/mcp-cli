import type { DaemonStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureDaemonRunning } from "../ensure-daemon";
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
  /** Override ensureDaemonRunning for testing (dependency injection). */
  ensureDaemonFn?: () => Promise<boolean>;
}

export function useDaemon(opts: UseDaemonOptions = {}): UseDaemonResult {
  const { intervalMs = 2500, ipcCallFn = ipcCall, ensureDaemonFn = ensureDaemonRunning } = opts;
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const startingRef = useRef(false);

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
          startingRef.current = false;
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
          // Attempt to auto-start the daemon on connection failure (#412).
          // Guard with startingRef to avoid concurrent spawn attempts.
          if (!startingRef.current) {
            startingRef.current = true;
            const started = await ensureDaemonFn();
            if (started && !cancelled) {
              // Daemon came up — retry the poll immediately instead of showing error.
              try {
                const result = await ipcCallFn("status");
                if (!cancelled) {
                  startingRef.current = false;
                  const mismatch = checkProtocolVersion(result.protocolVersion);
                  if (mismatch) {
                    console.error(mismatch);
                    process.exit(2);
                  }
                  setStatus(result);
                  setError(null);
                  setLoading(false);
                  return;
                }
              } catch {
                // Fall through to error state
              }
            }
          }
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
  }, [intervalMs, ipcCallFn, ensureDaemonFn, tick]);

  return { status, error, loading, refresh };
}
