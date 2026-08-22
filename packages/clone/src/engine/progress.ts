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
import type { VfsOperation, VfsPhase, VfsProgressFields } from "@mcp-cli/core";
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
 * socket is guaranteed to have flushed before the operation returns. Must not
 * throw or reject — the reporter does not guard it, and a clone must not fail
 * over its own telemetry.
 */
export type VfsProgressSink = (event: VfsProgressEvent) => void | Promise<void>;

/** Emit one update per this share of a known total (5% → up to 20 per phase). */
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
 * Decide whether `current` deserves an update given the last one emitted.
 *
 * With a known total the step is a share of it but never below `minStep`, so a
 * 5000-item scope reports every 250 items and a 40-item scope reports every 10
 * rather than every one; the tick that reaches the total always reports, so a
 * phase never ends mid-bar. Without a total the step is a flat item count.
 * Overshoot (an estimate that came in low) falls back to the step rule rather
 * than reporting every single item.
 */
export function shouldReport(
  current: number,
  total: number | undefined,
  lastReported: number,
  throttle: ProgressThrottle = {},
): boolean {
  if (current <= lastReported) return false;

  if (total !== undefined && total > 0) {
    if (current >= total && lastReported < total) return true;
    const percentStep = throttle.percentStep ?? DEFAULT_PERCENT_STEP;
    const minStep = throttle.minStep ?? MIN_PERCENT_STEP_ITEMS;
    const step = Math.max(minStep, Math.ceil((total * percentStep) / 100));
    return current - lastReported >= step;
  }

  return current - lastReported >= (throttle.countStep ?? DEFAULT_COUNT_STEP);
}

/** `current`/`total` as a 0-100 integer, clamped so a low estimate can't exceed 100. */
export function percentOf(current: number, total: number | undefined): number | undefined {
  if (total === undefined || total <= 0) return undefined;
  return Math.min(100, Math.floor((current / total) * 100));
}

const PHASE_LABEL: Record<VfsPhase, string> = {
  list: "Fetching",
  content: "Fetching content for",
};

/** Fallback noun when a provider doesn't name what it counts. */
export const DEFAULT_UNIT = "items";

/** Render the stderr line: `  Fetching FOO... 250/5000 pages (5%)`. */
export function formatProgressLine(e: VfsProgressEvent): string {
  const label = e.phase ? PHASE_LABEL[e.phase] : "Fetching";
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

/** The last position a phase reported, whether or not it was emitted. */
interface Position {
  phase: VfsPhase;
  current: number;
  total?: number;
}

/**
 * Throttled, per-phase progress reporter.
 *
 * Each phase tracks its own last-reported count, so switching from `list` to
 * `content` restarts the bar instead of suppressing updates because the counter
 * went backwards.
 */
export class ProgressReporter {
  private readonly lastReported = new Map<VfsPhase, number>();
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
   * Record that `current` items of `phase` are done. Emits at most one update per
   * throttle step; returns whether this call produced one.
   */
  async tick(phase: VfsPhase, current: number, total?: number): Promise<boolean> {
    this.position = { phase, current, ...(total === undefined ? {} : { total }) };
    const last = this.lastReported.get(phase) ?? 0;
    if (!shouldReport(current, total, last, this.opts.throttle)) return false;
    this.lastReported.set(phase, current);

    const event: VfsProgressEvent = { event: VFS_PROGRESS, ...this.base(), ...this.tail() };
    this.opts.log(formatProgressLine(event));
    await this.emit(event);
    return true;
  }

  /**
   * Publish the success terminal event. The engine keeps ownership of its
   * summary line. `items` is what the run *produced* (pages cloned, changes
   * applied) — deliberately a separate field from `current`/`total`, which stay
   * in the unit of the last phase so a subscriber tracking the bar doesn't see
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
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private base(): Pick<VfsProgressFields, "runId" | "operation" | "provider" | "scope" | "repoRoot" | "unit"> {
    const { operation, provider, scope, repoRoot, unit } = this.opts;
    return { runId: this.runId, operation, provider, scope, repoRoot, unit: unit ?? DEFAULT_UNIT };
  }

  /** Current position as event fields — `{current: 0}` before the first tick. */
  private tail(): Pick<VfsProgressFields, "phase" | "current" | "total" | "percent"> {
    if (!this.position) return { current: 0 };
    const { phase, current, total } = this.position;
    const percent = percentOf(current, total);
    return {
      phase,
      current,
      ...(total === undefined ? {} : { total }),
      ...(percent === undefined ? {} : { percent }),
    };
  }

  private async emit(event: VfsProgressEvent): Promise<void> {
    await this.opts.onEvent?.(event);
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
