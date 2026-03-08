import type { GetDaemonLogsResult, GetLogsResult, LogEntry, ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type LogSource = { type: "daemon" } | { type: "server"; name: string };

/** Build the ordered list of log sources: daemon + one per server. */
export function buildLogSources(servers: ServerStatus[]): LogSource[] {
  return [{ type: "daemon" }, ...servers.map((s) => ({ type: "server" as const, name: s.name }))];
}

/** Case-insensitive substring filter for log entries. */
export function filterLogLines(lines: LogEntry[], filterText: string): LogEntry[] {
  if (!filterText) return lines;
  const lower = filterText.toLowerCase();
  return lines.filter((entry) => entry.line.toLowerCase().includes(lower));
}

const MAX_LINES = 500;
const INITIAL_LIMIT = 50;
const POLL_INTERVAL_MS = 1000;

interface UseLogsResult {
  lines: LogEntry[];
  source: LogSource;
  setSource: (source: LogSource) => void;
}

export function useLogs(servers: ServerStatus[]): UseLogsResult {
  const [source, setSourceRaw] = useState<LogSource>({ type: "daemon" });
  const [lines, setLines] = useState<LogEntry[]>([]);
  const sinceRef = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    setLines([]);
    sinceRef.current = undefined;
  }, []);

  const setSource = useCallback(
    (next: LogSource) => {
      clear();
      setSourceRaw(next);
    },
    [clear],
  );

  useEffect(() => {
    let cancelled = false;
    let isFirst = true;

    async function poll() {
      try {
        let fetched: LogEntry[];

        if (source.type === "daemon") {
          const params: Record<string, unknown> = {};
          if (isFirst) {
            params.limit = INITIAL_LIMIT;
          } else if (sinceRef.current !== undefined) {
            params.since = sinceRef.current;
          }
          const result = (await ipcCall("getDaemonLogs", params)) as GetDaemonLogsResult;
          fetched = result.lines;
        } else {
          const params: Record<string, unknown> = { server: source.name };
          if (isFirst) {
            params.limit = INITIAL_LIMIT;
          } else if (sinceRef.current !== undefined) {
            params.since = sinceRef.current;
          }
          const result = (await ipcCall("getLogs", params)) as GetLogsResult;
          fetched = result.lines;
        }

        if (cancelled) return;

        if (fetched.length > 0) {
          sinceRef.current = fetched[fetched.length - 1].timestamp;

          setLines((prev) => {
            if (isFirst) return fetched.slice(-MAX_LINES);
            const merged = [...prev, ...fetched];
            return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
          });
        }

        isFirst = false;
      } catch {
        // Daemon unreachable — skip this tick
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [source]);

  return { lines, source, setSource };
}
