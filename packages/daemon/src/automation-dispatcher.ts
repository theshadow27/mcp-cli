/**
 * Automation module dispatcher.
 *
 * Subscribes to the daemon EventBus, matches incoming events against
 * registered automation modules, executes handlers in subprocess workers,
 * and emits audit events for every dispatch outcome.
 *
 * Module handlers run in isolated Bun subprocesses (same model as alias
 * execution) so a crash cannot take down the daemon.
 *
 * #2018
 */

import { resolve } from "node:path";
import type {
  AutomationAction,
  AutomationAuditEntry,
  AutomationConfig,
  AutomationContext,
  AutomationDefinition,
  AutomationLogEntry,
  AutomationModuleInfo,
  AutomationOutcome,
  AutomationPreset,
  LockedAutomation,
  MonitorEvent,
} from "@mcp-cli/core";
import { isModuleEnabledForItem, parseAutomationOverrides } from "@mcp-cli/core";
import type { EventBus } from "./event-bus";

const AUDIT_RING_CAPACITY = 200;
const MODULE_TIMEOUT_MS = 30_000;

interface RegisteredModule {
  name: string;
  resolvedPath: string;
  contentHash: string;
  events: Set<string>;
  enabled: boolean;
}

export class AutomationDispatcher {
  private modules = new Map<string, RegisteredModule>();
  private preset: AutomationPreset = "supervised";
  private subscriptionId: number | null = null;
  private auditRing: AutomationAuditEntry[] = [];
  private auditHead = 0;
  private auditCount = 0;
  private auditTotal = 0;
  private repoRoot: string;
  private eventBus: EventBus;
  private getWorkItemOverrides: (workItemId: string) => string | undefined;
  private resolveWorkItemId: (prNumber: number) => string | undefined;
  private executeModule: (module: RegisteredModule, event: MonitorEvent) => Promise<AutomationAction>;

  constructor(opts: {
    eventBus: EventBus;
    repoRoot: string;
    getWorkItemOverrides?: (workItemId: string) => string | undefined;
    resolveWorkItemId?: (prNumber: number) => string | undefined;
    executeModule?: (module: RegisteredModule, event: MonitorEvent) => Promise<AutomationAction>;
  }) {
    this.eventBus = opts.eventBus;
    this.repoRoot = opts.repoRoot;
    this.getWorkItemOverrides = opts.getWorkItemOverrides ?? (() => undefined);
    this.resolveWorkItemId = opts.resolveWorkItemId ?? (() => undefined);
    this.executeModule = opts.executeModule ?? this.defaultExecuteModule.bind(this);
  }

  load(config: AutomationConfig, locked: LockedAutomation[]): void {
    this.modules.clear();
    this.preset = config.preset ?? "supervised";

    for (const entry of locked) {
      this.modules.set(entry.name, {
        name: entry.name,
        resolvedPath: entry.resolvedPath,
        contentHash: entry.contentHash,
        events: new Set(entry.events),
        enabled: entry.enabled,
      });
    }
  }

  start(): void {
    if (this.subscriptionId !== null) return;
    if (this.modules.size === 0) return;

    const allEvents = new Set<string>();
    for (const mod of this.modules.values()) {
      for (const e of mod.events) allEvents.add(e);
    }

    this.subscriptionId = this.eventBus.subscribe(
      (event) => {
        this.onEvent(event).catch((err) => {
          console.error("[AutomationDispatcher] unhandled error in onEvent:", err);
        });
      },
      (event) => allEvents.has(event.event),
    );
  }

  stop(): void {
    if (this.subscriptionId !== null) {
      this.eventBus.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  private resolveWorkItemIdFromEvent(event: MonitorEvent): string | undefined {
    if (typeof event.workItemId === "string") return event.workItemId;
    if (typeof event.prNumber === "number") return this.resolveWorkItemId(event.prNumber);
    return undefined;
  }

  private async onEvent(event: MonitorEvent): Promise<void> {
    for (const mod of this.modules.values()) {
      if (!mod.events.has(event.event)) continue;

      const workItemId = this.resolveWorkItemIdFromEvent(event);
      const overrides = parseAutomationOverrides(workItemId ? this.getWorkItemOverrides(workItemId) : undefined);

      if (!isModuleEnabledForItem(mod.name, mod.enabled, this.preset, overrides)) {
        const skipReason = "disabled by config or override";
        this.recordAudit(mod.name, "skipped", event.event, workItemId, null, null, skipReason, 0);
        this.emitAuditEvent(mod.name, "skipped", event, { skipReason });
        continue;
      }

      const start = performance.now();
      let action: AutomationAction;
      let outcome: AutomationOutcome;
      let error: string | null = null;

      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        action = await Promise.race([
          this.executeModule(mod, event),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`module "${mod.name}" timed out after ${MODULE_TIMEOUT_MS}ms`)),
              MODULE_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));

        if (action.action === "escalate") {
          outcome = "escalated";
        } else {
          outcome = "fired";
        }
      } catch (err) {
        outcome = "errored";
        error = err instanceof Error ? err.message : String(err);
        action = { action: "none", reason: `error: ${error}` };
      }

      const durationMs = Math.round(performance.now() - start);
      this.recordAudit(mod.name, outcome, event.event, workItemId, action, error, null, durationMs);
      this.emitAuditEvent(mod.name, outcome, event, {
        actionType: action.action,
        error,
        durationMs,
        ...(action.action === "escalate" && { reason: action.reason }),
      });
    }
  }

  private emitAuditEvent(
    moduleName: string,
    outcome: AutomationOutcome,
    triggerEvent: MonitorEvent,
    extra: Record<string, unknown>,
  ): void {
    const eventName = `automation.${outcome}` as const;
    this.eventBus.publish({
      src: `automation:${moduleName}`,
      event: eventName,
      category: "automation",
      module: moduleName,
      triggerEvent: triggerEvent.event,
      triggerSeq: triggerEvent.seq,
      ...(triggerEvent.workItemId && { workItemId: triggerEvent.workItemId }),
      ...(triggerEvent.prNumber && { prNumber: triggerEvent.prNumber }),
      ...extra,
    });
  }

  private recordAudit(
    module: string,
    outcome: AutomationOutcome,
    event: string,
    workItemId: string | undefined,
    action: AutomationAction | null,
    error: string | null,
    skipReason: string | null,
    durationMs: number,
  ): void {
    const entry: AutomationAuditEntry = {
      module,
      outcome,
      event,
      workItemId,
      action,
      error,
      skipReason,
      ts: new Date().toISOString(),
      durationMs,
    };

    this.auditTotal++;
    if (this.auditCount < AUDIT_RING_CAPACITY) {
      this.auditRing.push(entry);
      this.auditCount++;
    } else {
      this.auditRing[this.auditHead] = entry;
      this.auditHead = (this.auditHead + 1) % AUDIT_RING_CAPACITY;
    }
  }

  listModules(): AutomationModuleInfo[] {
    const result: AutomationModuleInfo[] = [];
    for (const mod of this.modules.values()) {
      const fires = this.getAuditLog(mod.name).filter((e) => e.outcome === "fired").length;
      result.push({
        name: mod.name,
        resolvedPath: mod.resolvedPath,
        contentHash: mod.contentHash,
        events: [...mod.events],
        enabled: mod.enabled,
        recentFires: fires,
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAuditLog(moduleName?: string, limit = 50): AutomationLogEntry[] {
    const entries: AutomationAuditEntry[] = [];
    const n = Math.min(this.auditCount, AUDIT_RING_CAPACITY);
    const wrapped = this.auditTotal > AUDIT_RING_CAPACITY;

    for (let i = 0; i < n; i++) {
      const idx = wrapped ? (this.auditHead + i) % AUDIT_RING_CAPACITY : i;
      const entry = this.auditRing[idx];
      if (moduleName && entry.module !== moduleName) continue;
      entries.push(entry);
    }

    return entries.slice(-limit).map((e) => ({
      module: e.module,
      outcome: e.outcome,
      event: e.event,
      workItemId: e.workItemId,
      actionType: e.action?.action ?? null,
      error: e.error,
      skipReason: e.skipReason,
      ts: e.ts,
      durationMs: e.durationMs,
    }));
  }

  get moduleCount(): number {
    return this.modules.size;
  }

  get currentPreset(): AutomationPreset {
    return this.preset;
  }

  private async defaultExecuteModule(mod: RegisteredModule, event: MonitorEvent): Promise<AutomationAction> {
    const absPath = resolve(this.repoRoot, mod.resolvedPath);
    let exported: Record<string, unknown>;
    try {
      exported = await import(absPath);
    } catch (err) {
      throw new Error(
        `failed to load "${mod.name}" from ${mod.resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const def = exported.default as AutomationDefinition | undefined;
    if (!def || typeof def.fn !== "function") {
      throw new Error(`module "${mod.name}" has no default export with an fn() handler`);
    }

    const ctx: AutomationContext = {
      mcp: new Proxy({} as AutomationContext["mcp"], {
        get: (_, prop) => {
          throw new Error(`mcp.${String(prop)} is not available in automation context`);
        },
      }),
      state: new Proxy({} as AutomationContext["state"], {
        get: (_, prop) => {
          throw new Error(`state.${String(prop)} is not available in automation context`);
        },
      }),
      repoRoot: this.repoRoot,
      signal: AbortSignal.timeout(MODULE_TIMEOUT_MS),
      workItem: null,
      logger: {
        info: (msg: string) => console.log(`[automation:${mod.name}] ${msg}`),
        warn: (msg: string) => console.warn(`[automation:${mod.name}] ${msg}`),
        error: (msg: string) => console.error(`[automation:${mod.name}] ${msg}`),
      },
      emit: (evt) => {
        const { event: evtName, category: evtCategory, ...rest } = evt;
        this.eventBus.publish({
          src: `automation:${mod.name}`,
          event: evtName,
          category: evtCategory as "automation",
          ...rest,
        });
      },
    };

    return def.fn(event, ctx);
  }
}
