/**
 * Progress reporting for long-running clone/pull operations (#1249).
 *
 * A 5000-page clone used to print one line per 50 pages and nothing else, so
 * there was no way to tell a slow clone from a hung one. This module adds two
 * things on top of the existing `onProgress` stderr sink:
 *
 * 1. **A denominator.** Providers that can estimate their scope size up front
 *    implement `count()`; progress then renders as `250/5000 pages (5%)`.
 *    Providers that can't are unchanged apart from the counter.
 * 2. **Event-bus updates.** Every line the reporter prints is also handed to an
 *    optional `onEvent` sink as a `vfs.*` monitor event, so `mcx monitor` can
 *    watch a clone running in another terminal. There is no side channel — the
 *    command layer forwards these straight to the daemon's `publishEvent` IPC.
 *
 * Two properties the bus half depends on, both of which this module owns:
 *
 * - **Every `start()` is followed by exactly one terminal event** — `finish()`
 *   on success, `fail()` on any thrown error. A `vfs.started` trailing off into
 *   silence would reproduce on the bus the exact defect the stderr line fixes,
 *   and would hang `mcx monitor --until` / `ctx.waitForEvent` to their timeouts.
 * - **The sink is awaited.** `main()` resolving triggers `process.exit()`, which
 *   tears the event loop down before an un-awaited socket write lands (#2983).
 *   Best-effort telemetry means *swallow the error*, not *skip the await*: the
 *   publisher bounds its own timeout, and the reporter waits for it.
 *
 * Emission is throttled by *item count*, never by wall-clock time: the same
 * input sequence always produces the same updates, which keeps tests
 * deterministic (see test/CLAUDE.md — test the condition, not time passing).
 */
import type { VfsOperation, VfsProgressFields, VfsStage } from "@mcp-cli/core";
import { VFS_COMPLETED, VFS_FAILED, VFS_PROGRESS, VFS_STARTED, generateSpanId } from "@mcp-cli/core";
import type { RemoteProvider, ResolvedScope } from "../providers/provider";

/** One progress update, ready to be published as a flat monitor event. */
export interface VfsProgressEvent extends VfsProgressFields {
  /** Monitor event name — one of the `vfs.*` names. */
  event: typeof VFS_STARTED | typeof VFS_PROGRESS | typeof VFS_COMPLETED | typeof VFS_FAILED;
}

/**
 * Sink for progress events.
 *
 * May return a promise; the reporter awaits it, so a sink that writes to a
 * socket is guaranteed to have flushed before the operation returns.
 *
 * A sink that throws cannot fail the operation — the reporter swallows it. That
 * is a guarantee about the *engine*, not a licence: an implementation that
 * throws loses the update, and if it throws from the terminal event the stream
 * is left open, which is the one thing every subscriber here relies on.
 */
export type VfsProgressSink = (event: VfsProgressEvent) => void | Promise<void>;

/**
 * Share of a known total between updates — but only where that is *narrower*
 * than {@link DEFAULT_COUNT_STEP}, which is a hard ceiling on the gap.
 *
 * With these defaults the two rules cross at a total of 1000 (5% of 1000 is
 * exactly 50). Measured updates per stage:
 *
 * | items  | with an accurate `count()` | with no `count()` |
 * |--------|---------------------------|-------------------|
 * | 40     | 4                         | 0                 |
 * | 200    | 20                        | 4                 |
 * | 1000   | 20                        | 20                |
 * | 5000   | 100                       | 100               |
 * | 50000  | 1000                      | 1000              |
 *
 * So an estimate always buys the denominator and the percentage, and buys a
 * *finer* cadence only below 1000 items. At and above the crossover the flat
 * count rule governs — which is the pre-#1249 cadence (`fetched % 50`), and is
 * deliberate: see {@link shouldReport} for why the ceiling cannot be dropped.
 */
export const DEFAULT_PERCENT_STEP = 5;

/**
 * Never emit more often than one update per this many items, even when 5% of
 * the total is fewer. Without a floor a 40-page clone reports every single page
 * — 40 stderr lines and 40 IPC publishes where it used to print none.
 */
export const MIN_PERCENT_STEP_ITEMS = 10;

/** Emit one update per this many items when the total is unknown. */
export const DEFAULT_COUNT_STEP = 50;

export interface ProgressThrottle {
  /** Percent of a known total between updates. Defaults to {@link DEFAULT_PERCENT_STEP}. */
  percentStep?: number;
  /** Items between updates when no total is known. Defaults to {@link DEFAULT_COUNT_STEP}. */
  countStep?: number;
  /** Lower bound on the percent-derived step. Defaults to {@link MIN_PERCENT_STEP_ITEMS}. */
  minStep?: number;
}

/**
 * An estimate the run has already walked past is falsified, not merely low.
 *
 * `count()` and `list()` read different backends — on Confluence the CQL search
 * index versus the v2 content API — so a stale or permission-filtered index can
 * answer 100 for a space that yields 1000. Keeping that denominator would
 * render `990/100 pages (100%)` and, because the step is a share of it, emit
 * one update per 10 items for the whole overshoot: 5x the intended volume, in a
 * feature whose entire point is less noise. Past the estimate we admit we have
 * no denominator and fall back to plain counting.
 */
export function usableTotal(current: number, total: number | undefined): number | undefined {
  if (total === undefined || total <= 0) return undefined;
  return current > total ? undefined : total;
}

/**
 * Decide whether `current` deserves an update given the last one emitted.
 *
 * Two rules, and the tighter one wins:
 *
 * - **At most one update per `percentStep` of a usable total**, floored at
 *   `minStep` so a 40-item scope reports every 10 rather than every one. The
 *   tick that reaches the total always reports, so a stage never ends mid-bar.
 * - **At least one update per `countStep` items**, always. This is the rule
 *   that holds when there is no usable total, and it is also a *ceiling* on the
 *   percent-derived step.
 *
 * The two are not simultaneously satisfiable: above a total of 1000, 5% of the
 * total exceeds `countStep`, so the ceiling clamps the percent term away
 * entirely and a 5000-item stage emits 100 updates rather than 20. That is not
 * an oversight — it is the ceiling doing its job, and it is also the cadence
 * this feature replaces. See {@link DEFAULT_PERCENT_STEP} for the measured
 * table. If the volume above the crossover ever needs to come down, the fix is
 * a gap bounded by the items *already seen* rather than by a constant; a larger
 * constant cannot do it without reopening the hole below.
 *
 * The ceiling is the part that is easy to leave out, and leaving it out is
 * strictly worse than having no estimate at all. `usableTotal` guards an
 * estimate that came in *low*; an estimate that comes in *high* inflates the
 * step instead, and the run can finish before the step is ever reached. An
 * archived-heavy Confluence space whose CQL index answers 30,000 for a 300-page
 * listing produced **zero** progress lines — where the pre-#1249 code printed
 * six, and where having no `count()` at all prints six. A best-effort
 * denominator must never be able to silence the output it is decorating; the
 * flat count rule is the floor the whole feature stands on.
 */
export function shouldReport(
  current: number,
  total: number | undefined,
  lastReported: number,
  throttle: ProgressThrottle = {},
): boolean {
  if (current <= lastReported) return false;

  const countStep = throttle.countStep ?? DEFAULT_COUNT_STEP;
  const usable = usableTotal(current, total);
  if (usable !== undefined) {
    if (current >= usable && lastReported < usable) return true;
    const percentStep = throttle.percentStep ?? DEFAULT_PERCENT_STEP;
    const minStep = throttle.minStep ?? MIN_PERCENT_STEP_ITEMS;
    const step = Math.min(countStep, Math.max(minStep, Math.ceil((usable * percentStep) / 100)));
    return current - lastReported >= step;
  }

  return current - lastReported >= countStep;
}

/** `current`/`total` as a 0-100 integer, clamped so a low estimate can't exceed 100. */
export function percentOf(current: number, total: number | undefined): number | undefined {
  if (total === undefined || total <= 0) return undefined;
  return Math.min(100, Math.floor((current / total) * 100));
}

const STAGE_LABEL: Record<VfsStage, string> = {
  list: "Fetching",
  content: "Fetching content for",
};

/** Fallback noun when a provider doesn't name what it counts. */
export const DEFAULT_UNIT = "items";

/**
 * Ceiling on the `error` field of a terminal event, ellipsis included.
 *
 * The message goes into `monitor_events.payload`, which has a 7-day TTL and no
 * size cap — and the messages that reach here are the untrusted kind: an HTML
 * 500 body from a proxy, a Zod issue list naming every field.
 *
 * This is a volume control, not redaction. It removes the *tail*, and anything
 * worth redacting would appear at the head. No path in this repo appends
 * headers or URLs to the message today (`resilient-caller.ts` passes the MCP
 * tool's error text through verbatim); if one ever does, the control that case
 * needs is redaction, not a shorter string.
 */
export const MAX_ERROR_CHARS = 512;

/** Render an unknown throw as a bounded single-line message. */
export function truncateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Collapse first: an HTML body is mostly newlines, and a multi-line payload
  // wrecks the one-line-per-event monitor rendering.
  const message = raw.replace(/\s+/g, " ").trim();
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message;
}

/** Render the stderr line: `  Fetching FOO... 250/5000 pages (5%)`. */
export function formatProgressLine(e: VfsProgressEvent): string {
  const label = e.stage ? STAGE_LABEL[e.stage] : "Fetching";
  const pct = e.percent === undefined ? "" : ` (${e.percent}%)`;
  const of = e.total === undefined ? "" : `/${e.total}`;
  return `  ${label} ${e.scope}... ${e.current}${of} ${e.unit ?? DEFAULT_UNIT}${pct}`;
}

export interface ProgressReporterOptions {
  operation: VfsOperation;
  provider: string;
  scope: string;
  /**
   * Repo this operation targets — clone's target dir, pull's repo dir. Carried
   * on every event so repo-scoped monitors elsewhere on the box can filter it
   * out; an event without one passes *every* repo filter (`event-filter.ts`).
   */
  repoRoot: string;
  /** Noun for the counted items, from the provider. Defaults to {@link DEFAULT_UNIT}. */
  unit?: string;
  /** Human-readable sink — the engine's existing stderr logger. */
  log: (message: string) => void;
  /** Event-bus sink. Omitted when nothing is listening (tests, library use). */
  onEvent?: VfsProgressSink;
  throttle?: ProgressThrottle;
  /** Correlation id for the run. Defaults to a fresh span id; injectable for tests. */
  runId?: string;
}

/** The last position a stage reported, whether or not it was emitted. */
interface Position {
  stage: VfsStage;
  current: number;
  total?: number;
}

/**
 * Throttled, per-stage progress reporter.
 *
 * Each stage tracks its own last-reported count, so switching from `list` to
 * `content` restarts the bar instead of suppressing updates because the counter
 * went backwards.
 */
export class ProgressReporter {
  private readonly lastReported = new Map<VfsStage, number>();
  private readonly opts: ProgressReporterOptions;
  private readonly runId: string;
  /** Where the run actually got to, updated on every tick — throttled or not. */
  private position: Position | undefined;
  private started = false;
  private terminated = false;

  constructor(opts: ProgressReporterOptions) {
    this.opts = opts;
    this.runId = opts.runId ?? generateSpanId();
  }

  /** Announce the operation. Idempotent — only the first call emits. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { operation, provider, scope } = this.opts;
    this.opts.log(`${operation === "clone" ? "Cloning" : "Pulling"} ${provider}/${scope}...`);
    await this.emit({ event: VFS_STARTED, ...this.base(), current: 0 });
  }

  /**
   * Report the denominator once the provider has been asked for it.
   *
   * Only logs: the total reaches the bus on the first `vfs.progress`, and
   * emitting a second event for it would buy subscribers nothing.
   */
  announceTotal(total: number | undefined): void {
    if (total === undefined) return;
    this.opts.log(`  → ${total} ${this.opts.unit ?? DEFAULT_UNIT} to fetch`);
  }

  /**
   * Record that `current` items of `stage` are done. Emits at most one update per
   * throttle step; returns whether this call produced one.
   */
  async tick(stage: VfsStage, current: number, total?: number): Promise<boolean> {
    // An estimate the run has walked past is dropped rather than carried: the
    // bar must not render `990/100 (100%)`, and the step must not be a share of
    // a number the run has disproved. See usableTotal().
    const usable = usableTotal(current, total);
    this.position = { stage, current, ...(usable === undefined ? {} : { total: usable }) };
    const last = this.lastReported.get(stage) ?? 0;
    if (!shouldReport(current, total, last, this.opts.throttle)) return false;
    this.lastReported.set(stage, current);

    const event: VfsProgressEvent = { event: VFS_PROGRESS, ...this.base(), ...this.tail() };
    this.opts.log(formatProgressLine(event));
    await this.emit(event);
    return true;
  }

  /**
   * Publish the success terminal event. The engine keeps ownership of its
   * summary line. `items` is what the run *produced* (pages cloned, changes
   * applied) — deliberately a separate field from `current`/`total`, which stay
   * in the unit of the last stage so a subscriber tracking the bar doesn't see
   * it collapse to a different scale at the end.
   */
  async finish(items?: number): Promise<void> {
    if (!this.started || this.terminated) return;
    this.terminated = true;
    await this.emit({
      event: VFS_COMPLETED,
      ...this.base(),
      ...this.tail(),
      ...(items === undefined ? {} : { items }),
    });
  }

  /**
   * Publish the failure terminal event. Called from the engines' catch blocks so
   * an auth expiry, a rate limit, or a full disk still closes the stream.
   */
  async fail(error: unknown): Promise<void> {
    if (!this.started || this.terminated) return;
    this.terminated = true;
    await this.emit({
      event: VFS_FAILED,
      ...this.base(),
      ...this.tail(),
      error: truncateError(error),
    });
  }

  private base(): Pick<VfsProgressFields, "runId" | "operation" | "provider" | "scope" | "repoRoot" | "unit"> {
    const { operation, provider, scope, repoRoot, unit } = this.opts;
    return { runId: this.runId, operation, provider, scope, repoRoot, unit: unit ?? DEFAULT_UNIT };
  }

  /** Current position as event fields — `{current: 0}` before the first tick. */
  private tail(): Pick<VfsProgressFields, "stage" | "current" | "total" | "percent"> {
    if (!this.position) return { current: 0 };
    const { stage, current, total } = this.position;
    const percent = percentOf(current, total);
    return {
      stage,
      current,
      ...(total === undefined ? {} : { total }),
      ...(percent === undefined ? {} : { percent }),
    };
  }

  /**
   * Hand one event to the sink. Guarded, not merely documented as "must not
   * throw": `VfsProgressSink` is public API, and `terminated` latches before the
   * await. A sink that threw from `finish()` would propagate into the engine's
   * catch, find `fail()` already latched, and report a clone that wrote every
   * file and committed as a failure carrying no terminal event at all.
   */
  private async emit(event: VfsProgressEvent): Promise<void> {
    try {
      await this.opts.onEvent?.(event);
    } catch {
      // Telemetry is observational — a broken subscriber cannot fail a clone.
    }
  }
}

/**
 * Best-effort scope size from the provider's optional `count()`.
 *
 * A provider that can't count, one whose count call fails, and one that answers
 * with garbage all degrade the same way: `undefined`, and progress falls back to
 * a bare item counter. A clone must never fail over its progress denominator.
 *
 * Zero counts as "don't know", not as a real total: `0` would render a header
 * that says the space is empty next to a bar that keeps climbing, and an empty
 * space is indistinguishable from a `totalSize` the remote failed to populate.
 *
 * `limit` (the `--limit` flag) caps the answer, since the listing stops there.
 */
export async function estimateTotal(
  provider: RemoteProvider,
  scope: ResolvedScope,
  limit = 0,
): Promise<number | undefined> {
  if (!provider.count) return undefined;
  let total: number | undefined;
  try {
    total = await provider.count(scope);
  } catch {
    return undefined;
  }
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
  return limit > 0 ? Math.min(total, limit) : total;
}
