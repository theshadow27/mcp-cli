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
 */

import { spawn } from "node:child_process";

import { createCaptureLogger } from "./logger";
import type { Logger, ScriptFunction, Step, StepResult } from "./types";

export interface RunnerOptions {
  from?: string;
  only?: string;
  verbose?: boolean;
  failFast?: boolean;
  logger: Logger;
  /** Optional override for process.env (used in tests). */
  env?: Record<string, string | undefined>;
}

export interface RunReport {
  success: boolean;
  failures: Array<{ step: Step; index: number; durationMs: number; error?: string }>;
  totalMs: number;
}

export class StepRunner {
  private readonly steps: Step[] = [];
  constructor(private readonly opts: RunnerOptions) {}

  add(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  async run(): Promise<RunReport> {
    const { logger, from, only, failFast = true } = this.opts;
    const [startIdx, endIdx] = this.resolveRange();
    if (startIdx < 0) {
      logger.error(`step '${from ?? only}' not found. available: ${this.steps.map((s) => s.name).join(", ")}`);
      return { success: false, failures: [], totalMs: 0 };
    }
    const slice = this.steps.slice(startIdx, endIdx);
    const t0 = Date.now();
    const failures: RunReport["failures"] = [];

    for (const [i, step] of slice.entries()) {
      const idx = startIdx + i;
      const stepStart = Date.now();
      logger.info(`[${idx + 1}/${this.steps.length}] ${step.name} — ${step.description}`);

      const result = await this.runStep(step);
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

  private async runStep(step: Step): Promise<StepResult> {
    const capture = createCaptureLogger();
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

      if (!result.success) {
        // Replay captured output so the user sees what went wrong.
        capture.show(this.opts.logger);
      } else if (this.opts.verbose) {
        capture.show(this.opts.logger);
      }
      return result;
    } catch (err) {
      capture.show(this.opts.logger);
      const error = err instanceof Error ? err.message : String(err);
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
    const child = spawn(bin, args, { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
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

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}
