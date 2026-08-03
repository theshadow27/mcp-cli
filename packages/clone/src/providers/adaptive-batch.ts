/**
 * Adaptive batch sizing for paginated remote fetches.
 *
 * A fixed page size is wrong in both directions: too large and the remote
 * rate-limits every retry identically (the 429 is a property of the batch,
 * so retrying it unchanged cannot succeed); too small and a large space
 * costs needless round trips. This tracks per-request outcome and latency
 * to converge on the largest size the remote currently tolerates.
 */

export interface AdaptiveBatchOptions {
  /** Starting and maximum batch size (default: 250). */
  max?: number;
  /** Floor below which the batch is never shrunk (default: 25). */
  min?: number;
  /** A success at or below this latency counts as "fast" (default: 5000ms). */
  fastLatencyMs?: number;
  /** Consecutive fast successes required before growing (default: 3). */
  growAfter?: number;
  /** Multiplier applied when growing (default: 1.5). */
  growFactor?: number;
}

export class AdaptiveBatchSizer {
  private current: number;
  private fastStreak = 0;
  readonly max: number;
  readonly min: number;
  private readonly fastLatencyMs: number;
  private readonly growAfter: number;
  private readonly growFactor: number;

  constructor(opts: AdaptiveBatchOptions = {}) {
    this.max = Math.max(1, Math.floor(opts.max ?? 250));
    this.min = Math.max(1, Math.min(Math.floor(opts.min ?? 25), this.max));
    this.fastLatencyMs = opts.fastLatencyMs ?? 5000;
    this.growAfter = Math.max(1, opts.growAfter ?? 3);
    this.growFactor = opts.growFactor ?? 1.5;
    this.current = this.max;
  }

  /** The batch size to use for the next request. */
  get size(): number {
    return this.current;
  }

  /**
   * Halve the batch size after a rate-limited request.
   * Returns false when already at the floor, which the caller uses as the
   * signal to stop retrying and propagate the error.
   */
  shrink(): boolean {
    this.fastStreak = 0;
    if (this.current <= this.min) return false;
    this.current = Math.max(this.min, Math.floor(this.current / 2));
    return true;
  }

  /**
   * Record a successful request. A run of fast successes grows the batch
   * back toward `max`; a slow success holds steady and resets the run.
   */
  onSuccess(latencyMs: number): void {
    if (latencyMs > this.fastLatencyMs) {
      this.fastStreak = 0;
      return;
    }
    this.fastStreak++;
    if (this.fastStreak < this.growAfter) return;
    this.fastStreak = 0;
    this.current = Math.min(this.max, Math.ceil(this.current * this.growFactor));
  }
}
