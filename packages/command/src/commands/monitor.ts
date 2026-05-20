/**
 * mcx monitor — stream enriched events from the daemon's unified event bus.
 *
 * Default output (TTY): human-readable one-liner per event, ≤200 chars.
 * --json: raw NDJSON to stdout (composable with | jq).
 * --response-tail <sessionId>: opt-in session.response chunks for debugging.
 *
 * Part of #1486 (monitor epic), #1515 (projection layer).
 */

import { resolve } from "node:path";
import type { MonitorEvent } from "@mcp-cli/core";
import { formatMonitorEvent, globToRegex, openEventStream, resolveRealpath } from "@mcp-cli/core";

export interface MonitorArgs {
  json: boolean;
  responseTail: string | undefined;
  subscribe: string | undefined;
  session: string | undefined;
  pr: number | undefined;
  workItem: string | undefined;
  type: string | undefined;
  src: string | undefined;
  phase: string | undefined;
  repo: string | undefined;
  since: number | undefined;
  until: string | undefined;
  timeout: number | undefined;
  maxEvents: number | undefined;
  error: string | undefined;
}

export interface MonitorDeps {
  openEventStream: typeof openEventStream;
  isTTY: boolean;
  getCwd: () => string;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
  exit: (code: number) => never;
  onSigint: (fn: () => void) => void;
  onStdoutError: (fn: (err: Error) => void) => void;
  createTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

const defaultDeps: MonitorDeps = {
  openEventStream,
  isTTY: Boolean(process.stdout.isTTY),
  getCwd: () => process.cwd(),
  writeStdout: (line) => process.stdout.write(line),
  writeStderr: (line) => process.stderr.write(line),
  exit: (code) => process.exit(code),
  onSigint: (fn) => process.once("SIGINT", fn),
  onStdoutError: (fn) => process.stdout.on("error", fn),
};

export function parseMonitorArgs(args: string[]): MonitorArgs {
  let json = false;
  let responseTail: string | undefined;
  let subscribe: string | undefined;
  let session: string | undefined;
  let pr: number | undefined;
  let workItem: string | undefined;
  let type: string | undefined;
  let src: string | undefined;
  let phase: string | undefined;
  let repo: string | undefined;
  let since: number | undefined;
  let until: string | undefined;
  let timeout: number | undefined;
  let maxEvents: number | undefined;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--json" || arg === "-j") {
      json = true;
    } else if (arg === "--response-tail") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        error = "--response-tail requires a session ID";
        break;
      }
      responseTail = next;
    } else if (arg === "--subscribe") {
      subscribe = args[++i];
      if (!subscribe) {
        error = "--subscribe requires a value";
        break;
      }
    } else if (arg === "--session") {
      session = args[++i];
      if (!session) {
        error = "--session requires a value";
        break;
      }
    } else if (arg === "--pr") {
      const next = args[++i];
      const n = Number(next);
      if (!next || Number.isNaN(n)) {
        error = "--pr requires a number";
        break;
      }
      pr = n;
    } else if (arg === "--work-item") {
      workItem = args[++i];
      if (!workItem) {
        error = "--work-item requires a value";
        break;
      }
    } else if (arg === "--type") {
      type = args[++i];
      if (!type) {
        error = "--type requires a value";
        break;
      }
    } else if (arg === "--src") {
      src = args[++i];
      if (!src) {
        error = "--src requires a value";
        break;
      }
    } else if (arg === "--phase") {
      phase = args[++i];
      if (!phase) {
        error = "--phase requires a value";
        break;
      }
    } else if (arg === "--repo") {
      repo = args[++i];
      if (!repo) {
        error = "--repo requires a path";
        break;
      }
    } else if (arg === "--since") {
      const next = args[++i];
      const n = Number(next);
      if (!next || Number.isNaN(n)) {
        error = "--since requires a number";
        break;
      }
      since = n;
    } else if (arg === "--until") {
      until = args[++i];
      if (!until) {
        error = "--until requires an event type";
        break;
      }
    } else if (arg === "--timeout") {
      const next = args[++i];
      const n = Number(next);
      if (!next || Number.isNaN(n)) {
        error = "--timeout requires seconds";
        break;
      }
      timeout = n;
    } else if (arg === "--max-events") {
      const next = args[++i];
      const n = Number(next);
      if (!next || Number.isNaN(n) || n < 1) {
        error = "--max-events requires a positive integer";
        break;
      }
      maxEvents = n;
    } else if (arg === "--help" || arg === "-h") {
      error = "help";
    }
  }

  return {
    json,
    responseTail,
    subscribe,
    session,
    pr,
    workItem,
    type,
    src,
    phase,
    repo,
    since,
    until,
    timeout,
    maxEvents,
    error,
  };
}

const HELP = `mcx monitor — stream unified daemon events

Usage:
  mcx monitor [flags]

Output:
  Default (TTY): human-readable one-liner per event, ≤200 chars
  --json         Raw NDJSON to stdout (pipe-friendly)

Filters (evaluated server-side):
  --subscribe <categories>   Comma-separated: session,work_item,mail
  --session <id>             Filter to one session
  --pr <n>                   Filter to one PR number
  --work-item <id>           Filter to one work item (e.g. #1441)
  --type <name>              Event type filter (e.g. session.result)
  --src <pattern>            Source attribution filter
  --phase <name>             Only items in this phase
  --repo <path>              Scope to repo root (default: current working directory)
  --since <seq>              Replay from cursor (reserved)

Terminators:
  --until <pattern>          Exit when this event type is seen (glob: pr.*, session.*)
  --timeout <seconds>        Exit after N seconds
  --max-events <n>           Exit after N events

Debugging:
  --response-tail <id>       Include session.response chunks for this session`;

export async function cmdMonitor(args: string[], deps?: Partial<MonitorDeps>): Promise<void> {
  const d: MonitorDeps = { ...defaultDeps, ...deps };
  const parsed = parseMonitorArgs(args);

  if (parsed.error === "help") {
    d.writeStderr(`${HELP}\n`);
    return;
  }

  if (parsed.error) {
    d.writeStderr(`Error: ${parsed.error}\n\nRun 'mcx monitor --help' for usage.\n`);
    d.exit(1);
  }

  const useJson = parsed.json || !d.isTTY;

  const repo = resolveRealpath(resolve(parsed.repo ?? d.getCwd()));

  const { events, abort } = d.openEventStream({
    subscribe: parsed.subscribe,
    session: parsed.session,
    pr: parsed.pr,
    workItem: parsed.workItem,
    type: parsed.type,
    src: parsed.src,
    phase: parsed.phase,
    repo,
    since: parsed.since,
    responseTail: parsed.responseTail,
  });

  let done = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const finish = (code: number) => {
    if (done) return;
    done = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    abort();
    d.exit(code);
  };

  if (parsed.timeout !== undefined) {
    timeoutId = (d.createTimeout ?? setTimeout)(() => finish(0), parsed.timeout * 1000) as ReturnType<
      typeof setTimeout
    >;
  }

  d.onSigint(() => finish(0));
  d.onStdoutError((err) => {
    if ((err as Error & { code?: string }).code === "EPIPE") finish(0);
  });

  let count = 0;
  let terminatorSatisfied = false;
  const untilRegex = parsed.until !== undefined ? globToRegex(parsed.until) : undefined;

  try {
    for await (const event of events) {
      if (useJson) {
        d.writeStdout(`${JSON.stringify(event)}\n`);
      } else {
        d.writeStdout(`${formatMonitorEvent(event as MonitorEvent)}\n`);
      }

      count++;

      if (parsed.maxEvents !== undefined && count >= parsed.maxEvents) {
        terminatorSatisfied = true;
        abort();
        break;
      }

      if (untilRegex?.test((event as MonitorEvent).event)) {
        terminatorSatisfied = true;
        abort();
        break;
      }
    }
  } catch (err) {
    if (done) return; // already exiting cleanly
    if (err instanceof DOMException && err.name === "AbortError") {
      // Clean exit via timeout or SIGINT
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      d.writeStderr(`Error: ${msg}\n`);
      d.exit(1);
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (!done && !terminatorSatisfied) {
    const hasTerminator = parsed.until !== undefined || parsed.maxEvents !== undefined;
    if (hasTerminator) {
      done = true;
      d.writeStderr("monitor: stream ended before terminator\n");
      d.exit(2);
    }
  }
}
