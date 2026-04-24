/**
 * Monitor runtime — spawns defineMonitor aliases in subprocesses, iterates
 * their async generators, and forwards yielded events to the main-thread
 * EventBus with `src: "alias:<name>"`.
 *
 * Each monitor runs in its own Bun.spawn subprocess for fault isolation.
 * Communication is NDJSON over stdout. Crashes trigger exponential backoff
 * (5s → 60s → 300s) and a synthetic `alias.crashed` event on the bus.
 *
 * #1583
 */

import type { AliasType, Logger, MonitorCategory, MonitorEventInput } from "@mcp-cli/core";
import { bundleAlias } from "@mcp-cli/core";
import type { Subprocess } from "bun";
import type { EventBus } from "./event-bus";
import { workerPath } from "./worker-path";

export const MONITOR_RESTART_POLICY = {
  maxCrashes: 5,
  backoffDelaysMs: [5_000, 15_000, 60_000, 180_000, 300_000] as readonly number[],
  crashWindowMs: 600_000,
} as const;

export interface MonitorAlias {
  name: string;
  filePath: string;
  bundledJs?: string;
  sourceHash?: string;
  aliasType: AliasType;
}

const STDERR_RING_SIZE = 5;
const MAX_LINE_BUFFER = 1024 * 1024;
const HEALTHY_UPTIME_MS = 60_000;
const VALID_CATEGORIES: ReadonlySet<string> = new Set<MonitorCategory>([
  "session",
  "work_item",
  "ci",
  "mail",
  "heartbeat",
]);

interface RunningMonitor {
  name: string;
  proc: Subprocess;
  crashTimestamps: number[];
  attempt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  stderrRing: string[];
  startedAt: number;
}

export interface MonitorRuntimeOptions {
  bus: EventBus;
  logger: Logger;
  listMonitors: () => MonitorAlias[];
  getAlias: (name: string) => MonitorAlias | undefined;
}

export class MonitorRuntime {
  private readonly monitors = new Map<string, RunningMonitor>();
  private readonly restartLocks = new Map<string, Promise<void>>();
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly listMonitors: () => MonitorAlias[];
  private readonly getAlias: (name: string) => MonitorAlias | undefined;
  private readonly executorPath: string;
  private stopped = false;

  constructor(opts: MonitorRuntimeOptions) {
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.listMonitors = opts.listMonitors;
    this.getAlias = opts.getAlias;
    this.executorPath = workerPath("monitor-executor.ts");
  }

  async startAll(): Promise<void> {
    const monitors = this.listMonitors();
    for (const mon of monitors) {
      if (mon.aliasType !== "defineMonitor") continue;
      await this.spawnMonitor(mon);
    }
    if (this.monitors.size > 0) {
      this.logger.info(`[monitor-runtime] Started ${this.monitors.size} monitor(s)`);
    }
  }

  async restartMonitor(name: string): Promise<void> {
    const prev = this.restartLocks.get(name) ?? Promise.resolve();
    const current = prev.catch(() => {}).then(() => this.doRestartMonitor(name));
    this.restartLocks.set(name, current);
    try {
      await current;
    } finally {
      if (this.restartLocks.get(name) === current) {
        this.restartLocks.delete(name);
      }
    }
  }

  private async doRestartMonitor(name: string): Promise<void> {
    const existing = this.monitors.get(name);
    if (existing) {
      existing.stopped = true;
      if (existing.restartTimer) clearTimeout(existing.restartTimer);
      await this.killProc(existing.proc, 5_000);
      this.monitors.delete(name);
    }
    const alias = this.getAlias(name);
    if (!alias || alias.aliasType !== "defineMonitor") return;
    const ok = await this.spawnMonitor(alias);
    if (ok) {
      this.logger.info(`[monitor-runtime] Restarted monitor "${name}"`);
    } else {
      this.logger.warn(`[monitor-runtime] Failed to restart monitor "${name}"`);
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const stopPromises: Promise<void>[] = [];
    for (const [, mon] of this.monitors) {
      mon.stopped = true;
      if (mon.restartTimer) clearTimeout(mon.restartTimer);
      stopPromises.push(this.killProc(mon.proc, 5_000));
    }
    await Promise.allSettled(stopPromises);
    this.monitors.clear();
  }

  get runningCount(): number {
    return this.monitors.size;
  }

  private async spawnMonitor(alias: MonitorAlias): Promise<boolean> {
    let bundledJs = alias.bundledJs;
    if (!bundledJs) {
      try {
        const result = await bundleAlias(alias.filePath);
        bundledJs = result.js;
      } catch (err) {
        this.logger.error(`[monitor-runtime] Failed to bundle "${alias.name}": ${err}`);
        return false;
      }
    }

    const payload = JSON.stringify({ bundledJs, aliasName: alias.name });
    const proc = Bun.spawn([process.execPath, this.executorPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(payload);
    proc.stdin.end();

    const mon: RunningMonitor = {
      name: alias.name,
      proc,
      crashTimestamps: [],
      attempt: 0,
      restartTimer: null,
      stopped: false,
      stderrRing: [],
      startedAt: Date.now(),
    };
    this.monitors.set(alias.name, mon);

    this.readStdout(mon);
    this.readStderr(mon);
    this.watchExit(mon);
    return true;
  }

  private readStdout(mon: RunningMonitor): void {
    const stdout = mon.proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_LINE_BUFFER) {
            this.logger.warn(`[monitor-runtime] "${mon.name}" stdout buffer exceeded 1 MB, truncating`);
            buffer = buffer.slice(-MAX_LINE_BUFFER);
          }

          for (let newlineIdx = buffer.indexOf("\n"); newlineIdx !== -1; newlineIdx = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              const input: MonitorEventInput = {
                ...event,
                src: `alias:${mon.name}`,
                event: typeof event.event === "string" ? event.event : "unknown",
                category:
                  typeof event.category === "string" && VALID_CATEGORIES.has(event.category)
                    ? (event.category as MonitorCategory)
                    : "heartbeat",
              };
              this.bus.publish(input);
            } catch {
              this.logger.warn(`[monitor-runtime] "${mon.name}" yielded non-JSON: ${line.slice(0, 100)}`);
            }
          }
        }

        buffer += decoder.decode();
        const remaining = buffer.trim();
        if (remaining) {
          try {
            const event = JSON.parse(remaining) as Record<string, unknown>;
            const input: MonitorEventInput = {
              ...event,
              src: `alias:${mon.name}`,
              event: typeof event.event === "string" ? event.event : "unknown",
              category:
                typeof event.category === "string" && VALID_CATEGORIES.has(event.category)
                  ? (event.category as MonitorCategory)
                  : "heartbeat",
            };
            this.bus.publish(input);
          } catch {
            this.logger.warn(`[monitor-runtime] "${mon.name}" yielded non-JSON: ${remaining.slice(0, 100)}`);
          }
        }
      } catch {
        // Reader closed — expected on process exit
      }
    };

    pump();
  }

  private readStderr(mon: RunningMonitor): void {
    const stderr = mon.proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_LINE_BUFFER) {
            buffer = buffer.slice(-MAX_LINE_BUFFER);
          }

          for (let newlineIdx = buffer.indexOf("\n"); newlineIdx !== -1; newlineIdx = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (line) {
              this.logger.warn(`[monitor:${mon.name}] ${line}`);
              mon.stderrRing.push(line);
              if (mon.stderrRing.length > STDERR_RING_SIZE) {
                mon.stderrRing.shift();
              }
            }
          }
        }

        buffer += decoder.decode();
        const remaining = buffer.trim();
        if (remaining) {
          this.logger.warn(`[monitor:${mon.name}] ${remaining}`);
          mon.stderrRing.push(remaining);
          if (mon.stderrRing.length > STDERR_RING_SIZE) {
            mon.stderrRing.shift();
          }
        }
      } catch {
        // Reader closed
      }
    };

    pump();
  }

  private watchExit(mon: RunningMonitor): void {
    mon.proc.exited.then((code) => {
      if (mon.stopped || this.stopped) return;

      // Clean exit (code 0) means the generator completed — not a crash.
      if (code === 0) {
        this.logger.info(`[monitor-runtime] "${mon.name}" generator completed (exit 0)`);
        this.monitors.delete(mon.name);
        return;
      }

      const now = Date.now();
      mon.crashTimestamps.push(now);

      // Trim timestamps outside the window
      const cutoff = now - MONITOR_RESTART_POLICY.crashWindowMs;
      while (mon.crashTimestamps.length > 0 && (mon.crashTimestamps[0] ?? 0) <= cutoff) {
        mon.crashTimestamps.shift();
      }

      this.bus.publish({
        src: "daemon.alias-supervisor",
        event: "alias.crashed",
        category: "session",
        name: mon.name,
        errorMessage: `Monitor "${mon.name}" exited with code ${code}`,
        stackTail: mon.stderrRing.length > 0 ? mon.stderrRing.join("\n") : `exit code ${code}`,
      });

      if (mon.crashTimestamps.length >= MONITOR_RESTART_POLICY.maxCrashes) {
        this.logger.error(
          `[monitor-runtime] "${mon.name}" exceeded crash budget (${MONITOR_RESTART_POLICY.maxCrashes} in ${MONITOR_RESTART_POLICY.crashWindowMs / 1000}s) — giving up`,
        );
        this.monitors.delete(mon.name);
        return;
      }

      if (Date.now() - mon.startedAt >= HEALTHY_UPTIME_MS) {
        mon.attempt = 0;
      }
      const delay = getMonitorBackoff(mon.attempt, MONITOR_RESTART_POLICY.backoffDelaysMs);
      mon.attempt++;
      this.logger.warn(
        `[monitor-runtime] "${mon.name}" crashed (exit ${code}), restarting in ${delay}ms (attempt ${mon.attempt})`,
      );

      mon.restartTimer = setTimeout(async () => {
        if (mon.stopped || this.stopped) return;

        const preservedAttempt = mon.attempt;
        const preservedCrashTimestamps = [...mon.crashTimestamps];
        const preservedStderrRing = [...mon.stderrRing];

        this.monitors.delete(mon.name);

        const alias = this.getAlias(mon.name);
        if (!alias || alias.aliasType !== "defineMonitor") return;
        await this.spawnMonitor(alias);

        const respawned = this.monitors.get(mon.name);
        if (respawned) {
          respawned.attempt = preservedAttempt;
          respawned.crashTimestamps = preservedCrashTimestamps;
          respawned.stderrRing = preservedStderrRing;
        }
      }, delay);
    });
  }

  private async killProc(proc: Subprocess, timeoutMs: number): Promise<void> {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }

    const exited = Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
    const result = await exited;
    if (result === "timeout") {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }
}

export function getMonitorBackoff(attempt: number, delays: readonly number[]): number {
  if (attempt <= 0) return delays[0] ?? 5_000;
  return delays[attempt] ?? delays.at(-1) ?? 300_000;
}
