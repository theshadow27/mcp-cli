/**
 * mcx watch — a single-stream, filterable feed of a site's message events.
 *
 * `mcx watch teams <name|id>... [--since <iso>] [--ndjson] [--until <expr>] [--dry-run]`
 *
 * The Trouter push-stream watcher lives in the `_site` daemon worker and
 * publishes normalised `site.message` events on the daemon event bus. This
 * command:
 *   1. resolves the requested thread names/ids via `site_threads`,
 *   2. ensures the watcher is running for the site (`site_watch_start`),
 *   3. optionally REST-backfills from `--since` (`site_backfill`),
 *   4. subscribes to the unified event stream (reusing `openEventStream` +
 *      `globToRegex`, the same machinery as `mcx monitor`), filtering
 *      client-side to the requested threads.
 *
 * One ndjson line per event to stdout; status/errors to stderr.
 */

import type { IpcMethod, IpcMethodResult, MonitorEvent } from "@mcp-cli/core";
import { SITE_MESSAGE, SITE_SERVER_NAME, formatMonitorEvent, globToRegex, openEventStream } from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { parseFlags } from "../flags";

export interface WatchDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  openEventStream: typeof openEventStream;
  isTTY: boolean;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
  exit: (code: number) => never;
  onSigint: (fn: () => void) => void;
  onStdoutError: (fn: (err: Error) => void) => void;
}

const defaultDeps: WatchDeps = {
  ipcCall: defaultIpcCall,
  openEventStream,
  isTTY: Boolean(process.stdout.isTTY),
  writeStdout: (line) => process.stdout.write(line),
  writeStderr: (line) => process.stderr.write(line),
  exit: (code) => process.exit(code),
  onSigint: (fn) => process.once("SIGINT", fn),
  onStdoutError: (fn) => process.stdout.on("error", fn),
};

const HELP = `mcx watch — stream a site's message events, filtered to named threads

Usage:
  mcx watch <site> <name|id>... [flags]

Examples:
  mcx watch teams general devs           Watch two named threads (human output on a TTY)
  mcx watch teams general --ndjson       One JSON line per event
  mcx watch teams general --since 2026-08-28T09:00:00Z
  mcx watch teams general --until 'site.message' --max-events 5
  mcx watch teams general --dry-run      Validate + plan; no socket, no registrar POST

Flags:
  --since <iso|ms>   REST backfill from this time before switching to live
  --ndjson, -j       Raw NDJSON to stdout (default when stdout is not a TTY)
  --until <glob>     Exit when an event whose type matches is seen (e.g. site.message)
  --max-events <n>   Exit after N printed events
  --timeout <secs>   Exit after N seconds
  --dry-run          Resolve + validate config without opening a live socket
  --help, -h         Show this help
`;

export interface WatchArgs {
  site: string | undefined;
  threads: string[];
  since: string | undefined;
  ndjson: boolean;
  until: string | undefined;
  maxEvents: number | undefined;
  timeout: number | undefined;
  dryRun: boolean;
  error: string | undefined;
}

export function parseWatchArgs(args: string[]): WatchArgs {
  const { flags, positionals, errors, help } = parseFlags(args, {
    since: { type: "string" },
    ndjson: { type: "boolean", alias: "j" },
    until: { type: "string" },
    "max-events": { type: "number" },
    timeout: { type: "number" },
    "dry-run": { type: "boolean" },
  });

  let error: string | undefined;
  if (help) error = "help";
  else if (errors.length > 0) error = errors[0];

  const maxEvents = flags["max-events"] as number | undefined;
  if (maxEvents !== undefined && maxEvents < 1) error ??= "--max-events requires a positive integer";
  if (flags.since === "") error ??= "--since requires a value";
  if (flags.until === "") error ??= "--until requires a value";

  return {
    site: positionals[0],
    threads: positionals.slice(1),
    since: flags.since as string | undefined,
    ndjson: (flags.ndjson as boolean) ?? false,
    until: flags.until as string | undefined,
    maxEvents,
    timeout: flags.timeout as number | undefined,
    dryRun: (flags["dry-run"] as boolean) ?? false,
    error,
  };
}

interface ThreadListing {
  name: string;
  id: string;
  post: "allow" | "deny";
  notes?: string;
  watch: boolean;
}

/** Unwrap an MCP tool result to its parsed JSON payload, or throw its error text. */
function unwrapTool(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
  const text = r?.content?.[0]?.text ?? "";
  if (r?.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callSiteTool(deps: WatchDeps, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return unwrapTool(await deps.ipcCall("callTool", { server: SITE_SERVER_NAME, tool, arguments: args }));
}

/** ISO timestamp or bare epoch-ms → epoch-ms string. Returns null on an unparseable value. */
export function sinceToMs(since: string): string | null {
  if (/^\d+$/.test(since)) return since;
  const ms = Date.parse(since);
  return Number.isNaN(ms) ? null : String(ms);
}

export async function cmdWatch(args: string[], depsOverride?: Partial<WatchDeps>): Promise<void> {
  const deps: WatchDeps = { ...defaultDeps, ...depsOverride };
  const parsed = parseWatchArgs(args);

  if (parsed.error === "help") {
    deps.writeStderr(`${HELP}\n`);
    return;
  }
  if (parsed.error) {
    deps.writeStderr(`Error: ${parsed.error}\n\nRun 'mcx watch --help' for usage.\n`);
    deps.exit(1);
  }
  if (!parsed.site) {
    deps.writeStderr("Error: a site is required (e.g. 'mcx watch teams general')\n");
    deps.exit(1);
  }
  const site = parsed.site as string;

  // 1. Resolve thread names/ids.
  let listing: ThreadListing[] = [];
  try {
    const res = (await callSiteTool(deps, "site_threads", { site })) as { threads?: ThreadListing[] };
    listing = res.threads ?? [];
  } catch (err) {
    deps.writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    deps.exit(1);
  }
  const byName = new Map(listing.map((t) => [t.name, t.id]));
  const nameById = new Map(listing.map((t) => [t.id, t.name]));

  const resolvedIds = parsed.threads.map((tok) => byName.get(tok) ?? tok);
  const threadIds = resolvedIds.length > 0 ? resolvedIds : listing.map((t) => t.id);
  if (threadIds.length === 0) {
    deps.writeStderr(
      `Error: no threads to watch. Pass a thread name/id, or declare threads in ~/.mcp-cli/sites/${site}/threads.yaml\n`,
    );
    deps.exit(1);
  }
  const wanted = new Set(threadIds);

  const useJson = parsed.ndjson || !deps.isTTY;
  const printRecord = (event: MonitorEvent): void => {
    // Prefer the configured name over the wire topic for display.
    const named = nameById.get(String(event.thread));
    const enriched = named ? { ...event, threadName: named } : event;
    if (useJson) deps.writeStdout(`${JSON.stringify(enriched)}\n`);
    else deps.writeStdout(`${formatMonitorEvent(enriched as MonitorEvent)}\n`);
  };

  // 2. Dry-run: validate + plan only.
  if (parsed.dryRun) {
    const plan = await callSiteTool(deps, "site_watch_start", { site, threads: threadIds, dryRun: true });
    deps.writeStdout(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  // 3. Ensure the live watcher is running.
  try {
    await callSiteTool(deps, "site_watch_start", { site, threads: threadIds });
  } catch (err) {
    deps.writeStderr(`Error starting watcher: ${err instanceof Error ? err.message : String(err)}\n`);
    deps.exit(1);
  }

  // 4. Optional REST backfill from --since.
  if (parsed.since !== undefined) {
    const sinceMs = sinceToMs(parsed.since);
    if (sinceMs === null) {
      deps.writeStderr(`Error: --since '${parsed.since}' is not an ISO timestamp or epoch-ms value\n`);
      deps.exit(1);
    }
    try {
      const res = (await callSiteTool(deps, "site_backfill", { site, threads: threadIds, since: sinceMs })) as {
        records?: MonitorEvent[];
      };
      for (const rec of res.records ?? []) printRecord(rec);
    } catch (err) {
      deps.writeStderr(`Warning: backfill failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // 5. Live stream — reuse the unified event bus, filter client-side to our threads.
  const { events, abort } = deps.openEventStream({ type: SITE_MESSAGE });
  const untilRegex = parsed.until !== undefined ? globToRegex(parsed.until) : undefined;

  let done = false;
  let terminatorSatisfied = false;
  let count = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const finish = (code: number): void => {
    if (done) return;
    done = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    abort();
    deps.exit(code);
  };

  if (parsed.timeout !== undefined) {
    timeoutId = setTimeout(() => finish(0), parsed.timeout * 1000);
    timeoutId.unref?.();
  }
  deps.onSigint(() => finish(0));
  deps.onStdoutError((err) => {
    if ((err as Error & { code?: string }).code === "EPIPE") finish(0);
  });

  try {
    for await (const event of events) {
      const e = event as MonitorEvent;
      if (e.event === SITE_MESSAGE && e.site === site && wanted.has(String(e.thread))) {
        printRecord(e);
        count++;
        if (parsed.maxEvents !== undefined && count >= parsed.maxEvents) {
          terminatorSatisfied = true;
          abort();
          break;
        }
      }
      if (untilRegex?.test(e.event)) {
        terminatorSatisfied = true;
        abort();
        break;
      }
    }
  } catch (err) {
    if (done) return;
    if (err instanceof DOMException && err.name === "AbortError") {
      // clean exit via timeout / SIGINT
    } else {
      deps.writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      deps.exit(1);
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (!done && !terminatorSatisfied && (parsed.until !== undefined || parsed.maxEvents !== undefined)) {
    deps.writeStderr("watch: stream ended before terminator\n");
    deps.exit(2);
  }
}
