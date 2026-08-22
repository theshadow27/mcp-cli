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
 * Emission is throttled by *item count*, never by wall-clock time: the same
 * input sequence always produces the same updates, which keeps tests
 * deterministic (see test/CLAUDE.md — test the condition, not time passing).
 */
import type { VfsOperation, VfsPhase, VfsProgressFields } from "@mcp-cli/core";
import { VFS_COMPLETED, VFS_PROGRESS, VFS_STARTED } from "@mcp-cli/core";
import type { RemoteProvider, ResolvedScope } from "../providers/provider";

/** One progress update, ready to be published as a flat monitor event. */
export interface VfsProgressEvent extends VfsProgressFields {
  /** Monitor event name — one of `vfs.started` / `vfs.progress` / `vfs.completed`. */
  event: typeof VFS_STARTED | typeof VFS_PROGRESS | typeof VFS_COMPLETED;
}

/** Sink for progress events. Must not throw — the reporter does not guard it. */
export type VfsProgressSink = (event: VfsProgressEvent) => void;

/** Emit one update per this share of a known total (5% → 20 updates per phase). */
export const DEFAULT_PERCENT_STEP = 5;

/** Emit one update per this many items when the total is unknown. */
export const DEFAULT_COUNT_STEP = 50;

export interface ProgressThrottle {
  /** Percent of a known total between updates. Defaults to {@link DEFAULT_PERCENT_STEP}. */
  percentStep?: number;
  /** Items between updates when no total is known. Defaults to {@link DEFAULT_COUNT_STEP}. */
  countStep?: number;
}

/**
 * Decide whether `current` deserves an update given the last one emitted.
 *
 * With a known total the step is a share of it, so a 5000-item scope reports
 * every 250 items and a 20-item scope reports every item; the tick that reaches
 * the total always reports, so a phase never ends mid-bar. Without a total the
 * step is a flat item count. Overshoot (an estimate that came in low) falls back
 * to the step rule rather than reporting every single item.
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
    const step = Math.max(1, Math.ceil((total * percentStep) / 100));
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
  write: "Writing",
};

/** Render the stderr line: `  Fetching FOO... 250/5000 pages (5%)`. */
export function formatProgressLine(e: VfsProgressEvent): string {
  const label = e.phase ? PHASE_LABEL[e.phase] : "Fetching";
  const pct = e.percent === undefined ? "" : ` (${e.percent}%)`;
  const of = e.total === undefined ? "" : `/${e.total}`;
  return `  ${label} ${e.scope}... ${e.current}${of} pages${pct}`;
}

export interface ProgressReporterOptions {
  operation: VfsOperation;
  provider: string;
  scope: string;
  /** Human-readable sink — the engine's existing stderr logger. */
  log: (message: string) => void;
  /** Event-bus sink. Omitted when nothing is listening (tests, library use). */
  onEvent?: VfsProgressSink;
  throttle?: ProgressThrottle;
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

  constructor(opts: ProgressReporterOptions) {
    this.opts = opts;
  }

  /** Announce the operation, with the provider's up-front estimate if it has one. */
  start(total?: number): void {
    const { operation, provider, scope } = this.opts;
    const suffix = total === undefined ? "" : ` (${total} pages)`;
    this.opts.log(`${operation === "clone" ? "Cloning" : "Pulling"} ${provider}/${scope}...${suffix}`);
    this.emit({ event: VFS_STARTED, ...this.base(), current: 0, ...(total === undefined ? {} : { total }) });
  }

  /**
   * Record that `current` items of `phase` are done. Emits at most one update per
   * throttle step; returns whether this call produced one.
   */
  tick(phase: VfsPhase, current: number, total?: number): boolean {
    // A counter that moved backwards means the phase restarted — pull falls back
    // from an incremental sync to a full one and re-runs `content` from zero.
    // Without this reset the second pass would stay silent until it passed the
    // first pass's high-water mark.
    const previous = this.lastReported.get(phase) ?? 0;
    const last = current < previous ? 0 : previous;
    if (!shouldReport(current, total, last, this.opts.throttle)) return false;
    this.lastReported.set(phase, current);

    const percent = percentOf(current, total);
    const event: VfsProgressEvent = {
      event: VFS_PROGRESS,
      ...this.base(),
      phase,
      current,
      ...(total === undefined ? {} : { total }),
      ...(percent === undefined ? {} : { percent }),
    };
    this.opts.log(formatProgressLine(event));
    this.emit(event);
    return true;
  }

  /** Publish the terminal event. The engine keeps ownership of its summary line. */
  finish(total: number): void {
    this.emit({ event: VFS_COMPLETED, ...this.base(), current: total, total, percent: 100 });
  }

  private base(): Pick<VfsProgressFields, "operation" | "provider" | "scope"> {
    return { operation: this.opts.operation, provider: this.opts.provider, scope: this.opts.scope };
  }

  private emit(event: VfsProgressEvent): void {
    this.opts.onEvent?.(event);
  }
}

/**
 * Best-effort scope size from the provider's optional `count()`.
 *
 * A provider that can't count, one whose count call fails, and one that answers
 * with garbage all degrade the same way: `undefined`, and progress falls back to
 * a bare item counter. A clone must never fail over its progress denominator.
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
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return undefined;
  return limit > 0 ? Math.min(total, limit) : total;
}
