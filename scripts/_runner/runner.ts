/**
 * StepRunner — sequential executor for am-i-done's step list.
 *
 * Key behaviours:
 *
 *   1. Silent-first execution. Each step runs against a capture logger; on
 *      success we discard the buffer (the user only sees "✓ step (xms)"),
 *      on failure we replay it. This keeps the orchestrator context small
 *      when everything passes (the common case).
 *
 *   2. `--from <id>` / `--only <id>`. Resume support — when step 6 of 10
 *      fails, the user/agent re-runs with `--from 6` instead of re-paying
 *      for steps 1-5. `id` is a 1-indexed step number OR a case-insensitive
 *      substring of the step name.
 *
 *   3. Per-step critical flag. A non-critical step that fails logs a
 *      warning but does not stop the run. Used for cosmetic checks
 *      (e.g. coverage trend) where blocking would be noisy.
 *
 *   4. Failure summary. The runner always returns a {success, failures[]}
 *      shape so the caller can decide exit code, emit a final banner, or
 *      finalize the AI file logger.
 *
 *   5. Wall-clock deadline (#3261). The whole run is bounded — default 300s,
 *      `AM_I_DONE_TIMEOUT_MS` to override, <= 0 to disable. On expiry the
 *      runner names the in-flight step, dumps the output that step had
 *      produced so far (a wedged step never reaches the normal replay path,
 *      which is why #2973's 31-minute hang left a 1171-byte log), kills the
 *      whole child process TREE, and reports failure. This is a liveness
 *      ceiling only: no retries, no per-step watchdogs, nothing signalled
 *      during a healthy run.
 */

import { type GateLease, acquireGateLease } from "@mcp-cli/core";

import { type CaptureLogger, createCaptureLogger } from "./logger";
import { killTrackedTree, spawnTracked } from "./process-tree";
import type { Logger, ScriptFunction, Step, StepResult } from "./types";

/**
 * Default wall-clock ceiling for one `am-i-done` run. Sized for a developer /
 * agent gate: the observed local comprehensive run is well under this, and CI
 * — whose `check` job legitimately takes ~240s — raises it explicitly via
 * `AM_I_DONE_TIMEOUT_MS` in .github/workflows/ci.yml.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/** Race token: the wall-clock deadline fired before the run finished. */
const EXPIRED = Symbol("am-i-done-deadline-expired");

export interface RunnerOptions {
  from?: string;
  only?: string;
  /** Step names to omit from the run (substring match). */
  skip?: string[];
  verbose?: boolean;
  failFast?: boolean;
  logger: Logger;
  /** Optional override for process.env (used in tests). */
  env?: Record<string, string | undefined>;
  /** DI seam: gate-lease acquisition (injected in tests). */
  acquireLease?: typeof acquireGateLease;
  /**
   * Wall-clock ceiling for the whole run, in ms (#3261). Overrides
   * `AM_I_DONE_TIMEOUT_MS`; <= 0 disables the deadline entirely.
   */
  timeoutMs?: number;
  /** DI seam: process-tree kill on deadline expiry (injected in tests). */
  killTree?: typeof killTrackedTree;
}

export interface RunReport {
  success: boolean;
  failures: Array<{ step: Step; index: number; durationMs: number; error?: string }>;
  totalMs: number;
  /** True when the run was aborted by the wall-clock deadline (#3261). */
  timedOut?: boolean;
}

interface InFlight {
  step: Step;
  index: number;
  startedAt: number;
  capture: CaptureLogger;
}

export class StepRunner {
  private readonly steps: Step[] = [];
  private inFlight: InFlight | null = null;
  private lease: GateLease | null = null;
  /**
   * Time spent QUEUED on the gate lease, credited back to the deadline. The
   * lease is a bounded, self-reporting wait (it logs "waiting … remaining"
   * every 30s and fails open) — the opposite of the silent wedge this ceiling
   * defends against. Charging queueing to the budget would fail healthy runs
   * that merely waited their turn behind a peer worktree (#2690).
   */
  private leaseWaitMs = 0;
  /** Set while an acquisition is still in flight, so the credit accrues live. */
  private leaseQueuedAt: number | null = null;
  private timedOut = false;

  /** Gate-lease queueing so far, including an acquisition still in progress. */
  private leaseCreditMs(): number {
    return this.leaseWaitMs + (this.leaseQueuedAt === null ? 0 : Date.now() - this.leaseQueuedAt);
  }

  constructor(private readonly opts: RunnerOptions) {}

  add(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  async run(): Promise<RunReport> {
    const t0 = Date.now();
    const timeoutMs = this.resolveTimeoutMs();
    if (timeoutMs <= 0) return this.runSteps(t0);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let budgetAtExpiry = timeoutMs;
    // The timer only *settles* — the abort itself runs below, off the timer
    // callback, so expiry wins the race synchronously and the reported outcome
    // can never be a stale step failure produced by the tree we just killed.
    const expired = new Promise<typeof EXPIRED>((settle) => {
      // Re-arms rather than firing blind: the budget can grow while we wait
      // (gate-lease credit), and a re-check against the wall clock also
      // survives a suspended/throttled host that froze the timer.
      const tick = (): void => {
        const budgetMs = timeoutMs + this.leaseCreditMs();
        const remaining = budgetMs - (Date.now() - t0);
        if (remaining > 0) {
          timer = setTimeout(tick, remaining);
          return;
        }
        budgetAtExpiry = budgetMs;
        this.timedOut = true;
        settle(EXPIRED);
      };
      timer = setTimeout(tick, timeoutMs);
    });

    try {
      const outcome = await Promise.race([this.runSteps(t0), expired]);
      return outcome === EXPIRED ? await this.onDeadline(t0, budgetAtExpiry) : outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Resolve the wall-clock budget: explicit option, then AM_I_DONE_TIMEOUT_MS,
   * then the default. A non-numeric or negative env value disables the deadline
   * rather than silently substituting a number the operator did not choose.
   */
  private resolveTimeoutMs(): number {
    if (this.opts.timeoutMs !== undefined) return this.opts.timeoutMs;
    const raw = (this.opts.env ?? process.env).AM_I_DONE_TIMEOUT_MS;
    if (raw === undefined || raw.trim() === "") return DEFAULT_RUN_TIMEOUT_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_RUN_TIMEOUT_MS;
  }

  /**
   * The deadline fired. Say WHERE the run was, flush what the in-flight step
   * had produced (it never reaches the normal replay path — that is the whole
   * #2973 "empty log after a 31-minute hang" complaint), then take the child
   * process tree down and report a hard failure. Nothing is retried.
   */
  private async onDeadline(t0: number, budgetMs: number): Promise<RunReport> {
    const { logger } = this.opts;
    this.timedOut = true;
    const cur = this.inFlight;
    const totalMs = Date.now() - t0;

    logger.error(`\n⏱ am-i-done exceeded its ${formatMs(budgetMs)} wall-clock deadline — aborting (#3261)`);
    if (cur) {
      logger.error(
        `  in-flight: step [${cur.index + 1}/${this.steps.length}] ${cur.step.name} — ` +
          `stuck for ${formatMs(Date.now() - cur.startedAt)} (run total ${formatMs(totalMs)})`,
      );
    } else {
      logger.error(`  no step was in flight (run total ${formatMs(totalMs)})`);
    }
    const credited = this.leaseCreditMs();
    if (credited > 0) {
      logger.error(`  (${formatMs(credited)} of gate-lease queueing was credited back to the budget)`);
    }

    if (cur?.capture.isEmpty()) {
      logger.error(`  (${cur.step.name} produced no output before it wedged)`);
    } else if (cur) {
      logger.error(`  ── partial output from ${cur.step.name} ──`);
      cur.capture.show(logger);
      logger.error("  ── end partial output ──");
    }

    const { killed, survivors } = await (this.opts.killTree ?? killTrackedTree)();
    logger.error(`  killed ${killed.length} child process group(s)${killed.length ? `: ${killed.join(", ")}` : ""}`);
    if (survivors.length > 0) {
      logger.error(`  ⚠ ${survivors.length} process group(s) survived SIGKILL: ${survivors.join(", ")}`);
    }

    this.lease?.release();
    this.lease = null;

    const error = `wall-clock deadline of ${formatMs(budgetMs)} exceeded (#3261)`;
    if (cur) logger.error(`  ↻ rerun: bun run am-i-done --from ${cur.index + 1}`);
    return {
      success: false,
      timedOut: true,
      totalMs,
      failures: cur ? [{ step: cur.step, index: cur.index, durationMs: Date.now() - cur.startedAt, error }] : [],
    };
  }

  private async runSteps(t0: number): Promise<RunReport> {
    const { logger, from, only, skip, failFast = true } = this.opts;
    const [startIdx, endIdx] = this.resolveRange();
    if (startIdx < 0) {
      logger.error(`step '${from ?? only}' not found. available: ${this.steps.map((s) => s.name).join(", ")}`);
      return { success: false, failures: [], totalMs: 0 };
    }
    const slice = this.steps.slice(startIdx, endIdx);
    const failures: RunReport["failures"] = [];

    // Heavy test phases run under a host-global gate lease so N concurrent gate
    // runs across worktrees don't oversubscribe the host (#2690). Admission is
    // acquired ONCE PER RUN — lazily, at the first leased step, and held until
    // the run ends. Acquiring per step multiplied the admission budget by the
    // number of leased steps (three in the default list) and made a run wait on
    // the load its own previous step had just created. The lease logs waits /
    // fail-open to the real logger so contention stays visible even when the
    // step's own output is suppressed.
    try {
      for (const [i, step] of slice.entries()) {
        // The deadline already aborted and reported; don't start more work.
        if (this.timedOut) break;
        const idx = startIdx + i;
        if (skip && matchesAny(step.name, skip)) {
          logger.info(`[${idx + 1}/${this.steps.length}] ${step.name} — skipped (--skip)`);
          continue;
        }
        logger.info(`[${idx + 1}/${this.steps.length}] ${step.name} — ${step.description}`);
        // Published BEFORE the lease wait so a deadline that fires while this
        // step is still queued names this step, not the previous one.
        const inFlight: InFlight = { step, index: idx, startedAt: Date.now(), capture: createCaptureLogger() };
        this.inFlight = inFlight;

        if (step.lease && !this.lease) {
          const queuedAt = Date.now();
          this.leaseQueuedAt = queuedAt;
          try {
            this.lease = await (this.opts.acquireLease ?? acquireGateLease)({ logger });
          } finally {
            this.leaseWaitMs += Date.now() - queuedAt;
            this.leaseQueuedAt = null;
          }
          // Queue time is not step time: restart the clock so the reported
          // duration stays comparable to a run that never waited.
          inFlight.startedAt = Date.now();
        }

        const stepStart = inFlight.startedAt;
        const result = await this.runStep(inFlight);
        // The deadline fired while this step ran and already reported the
        // abort; its "exit 143" is our own kill, not a verdict worth printing.
        if (this.timedOut) break;
        const ms = Date.now() - stepStart;

        if (result.success) {
          logger.info(`  ✓ ${step.name} (${formatMs(ms)})`);
          continue;
        }
        const failure = { step, index: idx, durationMs: ms, error: result.error };
        failures.push(failure);
        if (step.critical === false) {
          logger.warn(`  ⚠ ${step.name} failed (${formatMs(ms)}) — non-critical, continuing`);
          emitOnFailure(logger, step);
          continue;
        }
        logger.error(`  ✗ ${step.name} failed (${formatMs(ms)})`);
        emitOnFailure(logger, step);
        logger.info(`  ↻ rerun: bun run am-i-done --from ${idx + 1}`);
        if (failFast) break;
      }
    } finally {
      this.inFlight = null;
      this.lease?.release();
      this.lease = null;
    }

    const totalMs = Date.now() - t0;
    return { success: failures.every((f) => f.step.critical === false), failures, totalMs };
  }

  private resolveRange(): [number, number] {
    const { from, only } = this.opts;
    if (only) {
      const i = this.findIndex(only);
      return i < 0 ? [-1, -1] : [i, i + 1];
    }
    if (from) {
      const i = this.findIndex(from);
      return i < 0 ? [-1, -1] : [i, this.steps.length];
    }
    return [0, this.steps.length];
  }

  private findIndex(spec: string): number {
    const n = Number.parseInt(spec, 10);
    if (Number.isInteger(n) && n >= 1 && n <= this.steps.length) return n - 1;
    return this.steps.findIndex((s) => s.name.toLowerCase().includes(spec.toLowerCase()));
  }

  /**
   * `inFlight` is created by the caller and already published on `this` so the
   * deadline path can name this step and dump its partial output — a wedged
   * step never reaches the replay lines below (#3261).
   */
  private async runStep({ step, capture }: InFlight): Promise<StepResult> {
    const opts = {
      args: step.args ?? [],
      env: { ...process.env, ...step.env },
      logger: capture,
    };

    try {
      const result =
        typeof step.command === "string"
          ? await runShell(step.command, opts.args, opts.env, capture)
          : await runFunction(step.command, opts);

      // After a timeout the deadline path already dumped this buffer and the
      // report is settled; replaying here would double-print the same output.
      if (this.timedOut) return result;
      if (!result.success) {
        // Replay captured output so the user sees what went wrong.
        capture.show(this.opts.logger);
      } else if (this.opts.verbose) {
        capture.show(this.opts.logger);
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.timedOut) return { success: false, error };
      capture.show(this.opts.logger);
      return { success: false, error };
    }
  }
}

async function runFunction(fn: ScriptFunction, opts: Parameters<ScriptFunction>[0]): Promise<StepResult> {
  const r = await fn(opts);
  if (r === undefined || r === null) return { success: true };
  if (typeof r === "boolean") return { success: r };
  return r;
}

async function runShell(
  command: string,
  extraArgs: string[],
  env: Record<string, string | undefined>,
  logger: Logger,
): Promise<StepResult> {
  const parts = command.trim().split(/\s+/);
  const bin = parts[0];
  if (!bin) return { success: false, error: "empty command" };
  const args = parts.slice(1).concat(extraArgs);

  // spawn() rejects undefined env values; drop them before handing the
  // env to the child so explicit `unset` semantics aren't required upstream.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;

  return new Promise((resolve) => {
    // spawnTracked, not spawn: the child leads its own process group so the
    // wall-clock deadline can take its whole descendant tree down (#3261).
    const child = spawnTracked(bin, args, { env: cleanEnv });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => logger.info(d.trimEnd()));
    child.stderr.on("data", (d: string) => logger.error(d.trimEnd()));
    child.on("error", (e: Error) => resolve({ success: false, error: e.message }));
    child.on("close", (code: number | null) =>
      resolve({ success: code === 0, error: code === 0 ? undefined : `exit ${code ?? "null"}` }),
    );
  });
}

function emitOnFailure(logger: Logger, step: Step): void {
  if (!step.onFailure) return;
  const hints = Array.isArray(step.onFailure) ? step.onFailure : [step.onFailure];
  for (const h of hints) logger.info(`  💡 ${h}`);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function matchesAny(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
