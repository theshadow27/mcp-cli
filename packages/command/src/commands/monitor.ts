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
import { isDaemonPidAlive } from "../daemon-lifecycle";
import { parseFlags } from "../flags";

// The daemon emits a heartbeat after 30s of event-bus silence (see
// EventStreamServer.EVENTBUS_HEARTBEAT_MS). A passive monitor should therefore
// see *something* at least every 30s from a live daemon. Wait for 3 missed
// heartbeats before declaring the channel dead, to tolerate GC / IO pauses.
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000;

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
  allRepos: boolean;
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
  /** Non-destructive probe: is the bound daemon's process + socket still alive? (#2508) */
  checkDaemonLiveness: () => boolean;
  /** Silence window before the liveness watchdog fires. `<= 0` disables it. */
  livenessTimeoutMs: number;
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
  checkDaemonLiveness: isDaemonPidAlive,
  livenessTimeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS,
};

export function parseMonitorArgs(args: string[]): MonitorArgs {
  const { flags, errors, help } = parseFlags(args, {
    json: { type: "boolean", alias: "j" },
    "response-tail": { type: "string" },
    subscribe: { type: "string" },
    session: { type: "string" },
    pr: { type: "number" },
    "work-item": { type: "string" },
    type: { type: "string" },
    src: { type: "string" },
    phase: { type: "string" },
    repo: { type: "string" },
    "all-repos": { type: "boolean" },
    since: { type: "number" },
    until: { type: "string" },
    timeout: { type: "number" },
    "max-events": { type: "number" },
  });

  let error: string | undefined;
  if (help) {
    error = "help";
  } else if (errors.length > 0) {
    error = errors[0];
  }

  // Pre-migration parsers explicitly rejected literal empty values (`if (!val)`);
  // parseFlags accepts `""`. Preserve prior error contract per-flag.
  const emptyChecks: Array<[string, string]> = [
    ["response-tail", "--response-tail requires a session ID"],
    ["subscribe", "--subscribe requires a value"],
    ["session", "--session requires a value"],
    ["work-item", "--work-item requires a value"],
    ["type", "--type requires a value"],
    ["src", "--src requires a value"],
    ["phase", "--phase requires a value"],
    ["repo", "--repo requires a path"],
    ["until", "--until requires a value"],
  ];
  for (const [key, msg] of emptyChecks) {
    if (flags[key] === "") {
      error ??= msg;
    }
  }

  const maxEvents = flags["max-events"] as number | undefined;
  if (maxEvents !== undefined && maxEvents < 1) {
    error = "--max-events requires a positive integer";
  }

  return {
    json: (flags.json as boolean) ?? false,
    responseTail: flags["response-tail"] as string | undefined,
    subscribe: flags.subscribe as string | undefined,
    session: flags.session as string | undefined,
    pr: flags.pr as number | undefined,
    workItem: flags["work-item"] as string | undefined,
    type: flags.type as string | undefined,
    src: flags.src as string | undefined,
    phase: flags.phase as string | undefined,
    repo: flags.repo as string | undefined,
    allRepos: (flags["all-repos"] as boolean) ?? false,
    since: flags.since as number | undefined,
    until: flags.until as string | undefined,
    timeout: flags.timeout as number | undefined,
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
  --all-repos               Disable repo scoping — show events from all repos
  --since <seq>              Replay from cursor (reserved)

Terminators:
  --until <pattern>          Exit when an event matching this pattern is seen (glob: pr.*, session.*)
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

  const repo = parsed.allRepos ? undefined : resolveRealpath(resolve(parsed.repo ?? d.getCwd()));

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
  let watchdogId: ReturnType<typeof setTimeout> | undefined;

  const clearWatchdog = () => {
    if (watchdogId !== undefined) {
      clearTimeout(watchdogId);
      watchdogId = undefined;
    }
  };

  const finish = (code: number) => {
    if (done) return;
    done = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    clearWatchdog();
    abort();
    d.exit(code);
  };

  const silenceSecs = () => Math.round(d.livenessTimeoutMs / 1000);

  // Liveness watchdog (#2508): a passive monitor must never silently outlive the
  // daemon it is bound to. Re-armed on every received event; if it fires, the
  // channel has been silent past the heartbeat window. Probe the daemon: if its
  // PID/socket are gone, the daemon is a corpse — exit loudly instead of hanging
  // blind. If the process is somehow still alive, warn and keep watching.
  const armWatchdog = () => {
    if (d.livenessTimeoutMs <= 0) return;
    clearWatchdog();
    watchdogId = (d.createTimeout ?? setTimeout)(() => {
      if (done) return;
      if (!d.checkDaemonLiveness()) {
        d.writeStderr(
          `monitor: bound daemon is not responding — no events or heartbeat for ${silenceSecs()}s and its PID/socket are gone. The daemon has died; exiting so you are not left blind.\n`,
        );
        finish(3);
      } else {
        d.writeStderr(
          `monitor: warning — no daemon heartbeat for ${silenceSecs()}s, but the daemon PID is alive. Still watching.\n`,
        );
        armWatchdog();
      }
    }, d.livenessTimeoutMs) as ReturnType<typeof setTimeout>;
    watchdogId.unref?.();
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

  // Arm before the first event so a daemon that dies immediately after bind is caught.
  armWatchdog();

  try {
    for await (const event of events) {
      armWatchdog();
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
    clearWatchdog();
  }

  if (!done && !terminatorSatisfied) {
    const hasTerminator = parsed.until !== undefined || parsed.maxEvents !== undefined;
    if (hasTerminator) {
      done = true;
      d.writeStderr("monitor: stream ended before terminator\n");
      d.exit(2);
    } else if (!d.checkDaemonLiveness()) {
      // Passive monitor with no terminator: the stream ended on its own. In
      // production openEventStream only ends when the socket closes, so a dead
      // daemon here means the channel died under us (#2508). Never return 0
      // blind — surface it loudly and exit non-zero.
      done = true;
      d.writeStderr(
        "monitor: bound daemon vanished — the event stream closed and its PID/socket are gone. Exiting non-zero instead of silently returning.\n",
      );
      d.exit(3);
    }
  }
}
