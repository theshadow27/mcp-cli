/**
 * mcx monitor — stream daemon events as NDJSON to stdout.
 *
 * Connects to the daemon's GET /events endpoint and writes each event
 * as one JSON line. Composable with `| jq`.
 *
 * Options:
 *   --subscribe <cats>   Comma-separated categories (e.g. "session,work_item")
 *   --session <id>       Filter to one session
 *   --pr <n>             Filter to one PR number
 *   --work-item <id>     Filter to one work item
 *   --type <globs>       Comma-separated event name globs (e.g. "pr.*,session.idle")
 *   --src <pattern>      Glob pattern against src field
 *   --phase <name>       Filter to a specific phase
 *   --since <seq>        Replay from cursor (passed to daemon)
 *   --until <type>       Exit (code 0) when this event type is seen
 *   --timeout <seconds>  Exit after N seconds (code 0)
 *   --max-events <n>     Exit after N events (code 0)
 *   --json               Raw JSON output (default; explicit for clarity)
 */

import { openEventStream } from "@mcp-cli/core";
import { printError } from "../output";

export interface MonitorArgs {
  subscribe?: string;
  session?: string;
  pr?: number;
  workItem?: string;
  type?: string;
  src?: string;
  phase?: string;
  since?: number;
  until?: string;
  timeout?: number;
  maxEvents?: number;
  error?: string;
}

export interface MonitorDeps {
  openEventStream: typeof openEventStream;
  printError: (msg: string) => void;
  writeStdout: (line: string) => void;
  writeStderr: (msg: string) => void;
  exit: (code: number) => never;
  onSigint: (fn: () => void) => void;
}

const defaultDeps: MonitorDeps = {
  openEventStream,
  printError,
  writeStdout: (line) => process.stdout.write(line),
  writeStderr: (msg) => process.stderr.write(msg),
  exit: (code) => process.exit(code),
  onSigint: (fn) => process.on("SIGINT", fn),
};

export function parseMonitorArgs(args: string[]): MonitorArgs {
  let subscribe: string | undefined;
  let session: string | undefined;
  let pr: number | undefined;
  let workItem: string | undefined;
  let type: string | undefined;
  let src: string | undefined;
  let phase: string | undefined;
  let since: number | undefined;
  let until: string | undefined;
  let timeout: number | undefined;
  let maxEvents: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--subscribe") {
      subscribe = args[++i];
      if (!subscribe) return { error: "--subscribe requires a value" };
    } else if (arg === "--session") {
      session = args[++i];
      if (!session) return { error: "--session requires a value" };
    } else if (arg === "--pr") {
      const raw = args[++i];
      if (!raw || Number.isNaN(Number(raw))) return { error: "--pr requires a number" };
      pr = Number(raw);
    } else if (arg === "--work-item") {
      workItem = args[++i];
      if (!workItem) return { error: "--work-item requires a value" };
    } else if (arg === "--type") {
      type = args[++i];
      if (!type) return { error: "--type requires a value" };
    } else if (arg === "--src") {
      src = args[++i];
      if (!src) return { error: "--src requires a value" };
    } else if (arg === "--phase") {
      phase = args[++i];
      if (!phase) return { error: "--phase requires a value" };
    } else if (arg === "--since") {
      const raw = args[++i];
      if (!raw || Number.isNaN(Number(raw))) return { error: "--since requires a number" };
      since = Number(raw);
    } else if (arg === "--until") {
      until = args[++i];
      if (!until) return { error: "--until requires an event type" };
    } else if (arg === "--timeout") {
      const raw = args[++i];
      if (!raw || Number.isNaN(Number(raw))) return { error: "--timeout requires a number" };
      timeout = Number(raw);
    } else if (arg === "--max-events") {
      const raw = args[++i];
      if (!raw || Number.isNaN(Number(raw))) return { error: "--max-events requires a number" };
      maxEvents = Number(raw);
    } else if (arg === "--json") {
      // no-op: JSON is always the output format
    } else if (arg.startsWith("-")) {
      return { error: `Unknown flag: ${arg}` };
    }
  }

  return { subscribe, session, pr, workItem, type, src, phase, since, until, timeout, maxEvents };
}

export async function cmdMonitor(args: string[], deps?: Partial<MonitorDeps>): Promise<void> {
  const d: MonitorDeps = { ...defaultDeps, ...deps };
  const parsed = parseMonitorArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const { events, abort } = d.openEventStream({
    since: parsed.since,
    subscribe: parsed.subscribe,
    session: parsed.session,
    pr: parsed.pr,
    workItem: parsed.workItem,
    type: parsed.type,
    src: parsed.src,
    phase: parsed.phase,
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const finish = (code: number) => {
    if (done) return;
    done = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    abort();
    d.exit(code);
  };

  d.onSigint(() => finish(0));

  if (parsed.timeout !== undefined) {
    timeoutHandle = setTimeout(() => finish(0), parsed.timeout * 1000);
    // Don't let the timer keep the process alive artificially
    timeoutHandle.unref?.();
  }

  let eventCount = 0;

  try {
    for await (const event of events) {
      // Skip internal control events (connected, heartbeat)
      const t = (event as Record<string, unknown>).t as string | undefined;
      if (t === "connected" || t === "heartbeat") continue;

      d.writeStdout(`${JSON.stringify(event)}\n`);
      eventCount++;

      if (parsed.maxEvents !== undefined && eventCount >= parsed.maxEvents) {
        finish(0);
        // finish calls d.exit which may throw (in tests) or not return (in prod)
        return;
      }

      if (parsed.until !== undefined) {
        const eventType = (event as Record<string, unknown>).event as string | undefined;
        if (eventType === parsed.until) {
          finish(0);
          return;
        }
      }
    }
  } catch (err) {
    if (done) return; // already exiting cleanly (finish was called)
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (err instanceof Error && err.message.includes("AbortError")) return;
    d.writeStderr(`monitor: ${err instanceof Error ? err.message : String(err)}\n`);
    d.exit(1);
  }
}
