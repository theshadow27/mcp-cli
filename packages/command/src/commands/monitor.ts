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
import { parseFlags } from "../flags";

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
