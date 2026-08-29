/**
 * mcx watch — a single-stream, filterable feed that interleaves a site's
 * message events with GitHub PR/CI events under one NDJSON envelope.
 *
 * `mcx watch <source>... [--since <iso>] [--ndjson] [--until <expr>] [--dry-run]`
 *
 * A positional is one of:
 *   - a **PR source** `gh:pr#<n>` (or `gh:pr:<n>`) → watch PR #<n>'s
 *     `pr.*` / `checks.*` / `ci.*` events, or
 *   - the classic `<site> <thread>...` form: the first non-`gh:` positional is
 *     the site, the rest are its thread names/ids.
 *
 * Both may be combined: `mcx watch teams general gh:pr#123` interleaves the
 * Teams thread's messages with PR #123's events on one stream. `mcx watch
 * gh:pr#123` (no site) is a PR-only watch that never starts the Trouter watcher.
 *
 * The Trouter push-stream watcher lives in the `_site` daemon worker and
 * publishes normalised `site.message` events on the daemon event bus; the
 * daemon's work-item poller emits `pr.*` / `checks.*` / `ci.*`. This command:
 *   1. classifies positionals into site/thread + PR sources,
 *   2. (site sources) resolves thread names/ids via `site_threads`, ensures the
 *      watcher is running (`site_watch_start`), optionally REST-backfills from
 *      `--since` (`site_backfill`),
 *   3. (PR sources) checks each PR is tracked — the poller only polls tracked
 *      work items — and WARNS on any that are not,
 *   4. subscribes to the unified event stream (reusing `openEventStream` +
 *      the `event-filter` matcher, the same machinery as `mcx monitor`) with a
 *      broad server-side type filter, then applies a client-side OR predicate
 *      that passes an event matching ANY source.
 *
 * One ndjson line per event to stdout; status/errors to stderr.
 */

import type { IpcMethod, IpcMethodResult, MonitorEvent } from "@mcp-cli/core";
import {
  SITE_MESSAGE,
  SITE_SERVER_NAME,
  createEventMatcher,
  formatMonitorEvent,
  globToRegex,
  openEventStream,
} from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { parseFlags } from "../flags";

/** Event-type globs a `gh:pr#N` source subscribes to (PR state + checks + CI runs). */
export const PR_EVENT_GLOBS = ["pr.*", "checks.*", "ci.*"] as const;

export interface WatchDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  openEventStream: typeof openEventStream;
  /** Resolve the set of PR numbers that are currently tracked (any domain). */
  listTrackedPrNumbers: () => Promise<Set<number>>;
  isTTY: boolean;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
  exit: (code: number) => never;
  onSigint: (fn: () => void) => void;
  onStdoutError: (fn: (err: Error) => void) => void;
}

/** Default tracked-PR lookup: mirrors `mcx tracked` (listWorkItems, current domain). */
async function defaultListTrackedPrNumbers(): Promise<Set<number>> {
  const res = await defaultIpcCall("listWorkItems", { cwd: process.cwd(), includeArchived: true });
  const set = new Set<number>();
  for (const item of res.items) {
    if (typeof item.prNumber === "number") set.add(item.prNumber);
  }
  return set;
}

const defaultDeps: WatchDeps = {
  ipcCall: defaultIpcCall,
  openEventStream,
  listTrackedPrNumbers: defaultListTrackedPrNumbers,
  isTTY: Boolean(process.stdout.isTTY),
  writeStdout: (line) => process.stdout.write(line),
  writeStderr: (line) => process.stderr.write(line),
  exit: (code) => process.exit(code),
  onSigint: (fn) => process.once("SIGINT", fn),
  onStdoutError: (fn) => process.stdout.on("error", fn),
};

const HELP = `mcx watch — one stream of a site's messages joined with GitHub PR/CI events

Usage:
  mcx watch <source>... [flags]

A <source> is either:
  <site> <thread>...   a site then its named threads (e.g. teams general devs)
  gh:pr#<n>            a GitHub PR (also gh:pr:<n>) — its pr.*/checks.*/ci.* events

Examples:
  mcx watch teams general devs           Watch two named threads (human output on a TTY)
  mcx watch teams general --ndjson       One JSON line per event
  mcx watch teams general gh:pr#123      Interleave a thread's messages with PR #123's events
  mcx watch gh:pr#123 gh:pr#124          PR-only watch (no Trouter watcher started)
  mcx watch teams general --since 2026-08-28T09:00:00Z
  mcx watch gh:pr#123 --until 'ci.finished' --max-events 5
  mcx watch teams general --dry-run      Validate + plan; no socket, no registrar POST

Flags:
  --since <iso|ms>   REST backfill from this time (site sources only) before live
  --ndjson, -j       Raw NDJSON to stdout (default when stdout is not a TTY)
  --until <glob>     Exit when an event whose type matches is seen (e.g. ci.finished)
  --max-events <n>   Exit after N printed events
  --timeout <secs>   Exit after N seconds
  --dry-run          Resolve + validate config without opening a live socket
  --help, -h         Show this help

Note: gh:pr#N only yields events while PR #N is tracked (mcx track N); watch warns
if it is not. az:pipeline sources are not yet supported.
`;

export interface WatchArgs {
  site: string | undefined;
  threads: string[];
  prNumbers: number[];
  since: string | undefined;
  ndjson: boolean;
  until: string | undefined;
  maxEvents: number | undefined;
  timeout: number | undefined;
  dryRun: boolean;
  error: string | undefined;
}

/** `gh:pr#123` / `gh:pr:123` → 123. Returns null for a non-PR-source token. */
function classifyPrSource(token: string): { prNumber: number } | { error: string } | null {
  if (!token.startsWith("gh:")) return null;
  const m = /^gh:pr[#:](\d+)$/.exec(token);
  if (!m) return { error: `invalid source token "${token}" (expected gh:pr#<number>)` };
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return { error: `invalid PR number in source token "${token}"` };
  return { prNumber: n };
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

  const prNumbers: number[] = [];
  const siteTokens: string[] = [];
  for (const tok of positionals) {
    const classified = classifyPrSource(tok);
    if (classified === null) {
      siteTokens.push(tok);
    } else if ("error" in classified) {
      error ??= classified.error;
    } else {
      prNumbers.push(classified.prNumber);
    }
  }

  const maxEvents = flags["max-events"] as number | undefined;
  if (maxEvents !== undefined && maxEvents < 1) error ??= "--max-events requires a positive integer";
  if (flags.since === "") error ??= "--since requires a value";
  if (flags.until === "") error ??= "--until requires a value";

  return {
    site: siteTokens[0],
    threads: siteTokens.slice(1),
    prNumbers,
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

/**
 * Build the client-side OR predicate: an event passes if it matches ANY source.
 *
 * The server-side stream filter is AND-combined and cannot express "(site.message
 * on these threads) OR (pr events for #N)", so we subscribe broadly by type and
 * OR one matcher per source here.
 */
export function buildSourceMatcher(opts: {
  site: string | undefined;
  wantedThreads: ReadonlySet<string>;
  prNumbers: readonly number[];
}): (event: MonitorEvent) => boolean {
  const { site, wantedThreads, prNumbers } = opts;
  const siteMatch =
    site !== undefined
      ? (e: MonitorEvent): boolean => e.event === SITE_MESSAGE && e.site === site && wantedThreads.has(String(e.thread))
      : undefined;
  const prMatchers = prNumbers.map((pr) => createEventMatcher({ type: [...PR_EVENT_GLOBS], pr }));
  return (event: MonitorEvent): boolean => {
    if (siteMatch?.(event)) return true;
    return prMatchers.some((m) => m(event));
  };
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

  const hasSite = parsed.site !== undefined;
  const hasPr = parsed.prNumbers.length > 0;
  if (!hasSite && !hasPr) {
    deps.writeStderr(
      "Error: a source is required — a site (e.g. 'mcx watch teams general') or a PR (e.g. 'mcx watch gh:pr#123')\n",
    );
    deps.exit(1);
  }
  const site = parsed.site;

  // PR sources: resolve tracked status up front. The work-item poller only polls
  // tracked items, so an untracked PR yields no events — warn, never auto-track
  // (mcx track <prNumber> is dangerous, see #3240).
  let trackedPrs = new Set<number>();
  if (hasPr) {
    try {
      trackedPrs = await deps.listTrackedPrNumbers();
    } catch (err) {
      deps.writeStderr(
        `Warning: could not determine which PRs are tracked (${err instanceof Error ? err.message : String(err)}); assuming none.\n`,
      );
    }
    for (const pr of parsed.prNumbers) {
      if (!trackedPrs.has(pr)) {
        deps.writeStderr(
          `warning: PR #${pr} is not tracked; no PR events will stream until 'mcx track ${pr}' is run\n`,
        );
      }
    }
  }

  // Site sources: resolve thread names/ids.
  let threadIds: string[] = [];
  const nameById = new Map<string, string>();
  if (hasSite && site !== undefined) {
    let listing: ThreadListing[] = [];
    try {
      const res = (await callSiteTool(deps, "site_threads", { site })) as { threads?: ThreadListing[] };
      listing = res.threads ?? [];
    } catch (err) {
      deps.writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      deps.exit(1);
    }
    const byName = new Map(listing.map((t) => [t.name, t.id]));
    for (const t of listing) nameById.set(t.id, t.name);

    const resolvedIds = parsed.threads.map((tok) => byName.get(tok) ?? tok);
    threadIds = resolvedIds.length > 0 ? resolvedIds : listing.map((t) => t.id);
    if (threadIds.length === 0) {
      deps.writeStderr(
        `Error: no threads to watch. Pass a thread name/id, or declare threads in ~/.mcp-cli/sites/${site}/threads.yaml\n`,
      );
      deps.exit(1);
    }
  }
  const wanted = new Set(threadIds);

  const useJson = parsed.ndjson || !deps.isTTY;
  const printRecord = (event: MonitorEvent): void => {
    // Prefer the configured name over the wire topic for display (site events only).
    const named = nameById.get(String(event.thread));
    const enriched = named ? { ...event, threadName: named } : event;
    if (useJson) deps.writeStdout(`${JSON.stringify(enriched)}\n`);
    else deps.writeStdout(`${formatMonitorEvent(enriched as MonitorEvent)}\n`);
  };

  // Dry-run: validate + plan only. No live socket, no registrar POST, no backfill.
  if (parsed.dryRun) {
    const plan: Record<string, unknown> = {};
    if (hasSite && site !== undefined) {
      plan.site = await callSiteTool(deps, "site_watch_start", { site, threads: threadIds, dryRun: true });
    }
    if (hasPr) {
      plan.prSources = parsed.prNumbers.map((pr) => ({ prNumber: pr, tracked: trackedPrs.has(pr) }));
    }
    // Back-compat: a site-only watch prints the raw site plan (with its `dryRun: true`).
    const output = hasSite && !hasPr ? plan.site : plan;
    deps.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  // Site sources: ensure the live watcher is running.
  if (hasSite && site !== undefined) {
    try {
      await callSiteTool(deps, "site_watch_start", { site, threads: threadIds });
    } catch (err) {
      deps.writeStderr(`Error starting watcher: ${err instanceof Error ? err.message : String(err)}\n`);
      deps.exit(1);
    }
  }

  // Optional REST backfill from --since (site sources only; PR sources have no backfill path).
  if (parsed.since !== undefined) {
    if (!hasSite || site === undefined) {
      deps.writeStderr("note: --since backfill applies to site sources only; PR sources have no backfill\n");
    } else {
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
  }

  // Live stream — subscribe broadly by type (server-side AND filter can't express
  // the cross-source OR), then filter client-side with the OR predicate.
  const typeGlobs: string[] = [];
  if (hasSite) typeGlobs.push(SITE_MESSAGE);
  if (hasPr) typeGlobs.push(...PR_EVENT_GLOBS);
  const { events, abort } = deps.openEventStream({ type: typeGlobs.join(",") });

  const matchesSource = buildSourceMatcher({ site, wantedThreads: wanted, prNumbers: parsed.prNumbers });
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
      if (matchesSource(e)) {
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
