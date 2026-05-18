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

import type {
  AutomationAction,
  AutomationAuditEntry,
  AutomationConfig,
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
  private executeModule: (module: RegisteredModule, event: MonitorEvent) => Promise<AutomationAction>;

  constructor(opts: {
    eventBus: EventBus;
    repoRoot: string;
    getWorkItemOverrides?: (workItemId: string) => string | undefined;
    executeModule?: (module: RegisteredModule, event: MonitorEvent) => Promise<AutomationAction>;
  }) {
    this.eventBus = opts.eventBus;
    this.repoRoot = opts.repoRoot;
    this.getWorkItemOverrides = opts.getWorkItemOverrides ?? (() => undefined);
    this.executeModule = opts.executeModule ?? defaultExecuteModule;
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

  private async onEvent(event: MonitorEvent): Promise<void> {
    for (const mod of this.modules.values()) {
      if (!mod.events.has(event.event)) continue;

      const workItemId = typeof event.workItemId === "string" ? event.workItemId : undefined;
      const overrides = parseAutomationOverrides(workItemId ? this.getWorkItemOverrides(workItemId) : undefined);

      if (!isModuleEnabledForItem(mod.name, mod.enabled, this.preset, overrides)) {
        this.recordAudit(mod.name, "skipped", event.event, workItemId, null, "disabled by config or override", 0);
        this.emitAuditEvent(mod.name, "skipped", event, { reason: "disabled by config or override" });
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
      this.recordAudit(mod.name, outcome, event.event, workItemId, action, error, durationMs);
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
    durationMs: number,
  ): void {
    const entry: AutomationAuditEntry = {
      module,
      outcome,
      event,
      workItemId,
      action,
      error,
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
}

async function defaultExecuteModule(module: RegisteredModule, _event: MonitorEvent): Promise<AutomationAction> {
  return {
    action: "none",
    reason: `module "${module.name}" loaded but no concrete handler registered (framework-only)`,
  };
}
