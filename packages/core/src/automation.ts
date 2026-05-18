/**
 * Automation module types, schemas, and helpers.
 *
 * Automation modules are small event-triggered handlers declared in `.mcx.yaml`
 * that perform mechanical pipeline steps without orchestrator involvement.
 * Framework introduced in #2018; individual modules are separate issues.
 */

import { z } from "zod";
import type { AliasContext } from "./alias";
import type { MonitorEvent } from "./monitor-event";

/**
 * Valid event names that automation modules can subscribe to.
 * Subset of monitor event names — only events with clear, mechanical triggers.
 */
export const AUTOMATION_EVENT_NAMES = [
  "pr.opened",
  "pr.pushed",
  "pr.merged",
  "pr.closed",
  "pr.label_added",
  "pr.review_comment_posted",
  "checks.started",
  "checks.passed",
  "checks.failed",
  "ci.started",
  "ci.running",
  "ci.finished",
  "review.approved",
  "review.changes_requested",
  "review.commented",
  "phase.changed",
  "session.ended",
  "session.result",
] as const;

export type AutomationEventName = (typeof AUTOMATION_EVENT_NAMES)[number];

const automationEventNameSet: ReadonlySet<string> = new Set(AUTOMATION_EVENT_NAMES);

export function isValidAutomationEvent(name: string): name is AutomationEventName {
  return automationEventNameSet.has(name);
}

/** Automation presets — sugar that expands to module enable/disable defaults. */
export const AUTOMATION_PRESETS = ["supervised", "semi-auto", "autonomous"] as const;
export type AutomationPreset = (typeof AUTOMATION_PRESETS)[number];

/** Default enabled state per preset, keyed by module name convention. */
const PRESET_DEFAULTS: Record<AutomationPreset, Record<string, boolean>> = {
  supervised: {},
  "semi-auto": { cleanup: true, bind: true },
  autonomous: { cleanup: true, bind: true, merge: true },
};

export function expandPreset(preset: AutomationPreset): Record<string, boolean> {
  return { ...PRESET_DEFAULTS[preset] };
}

// ── Schema ──

const AutomationEventNameSchema = z.string().refine(isValidAutomationEvent, {
  message: `unknown automation event; valid events: ${AUTOMATION_EVENT_NAMES.join(", ")}`,
});

export const AutomationModuleDefSchema = z
  .object({
    source: z.string().min(1, "module source must be a non-empty string"),
    on: z.array(AutomationEventNameSchema).min(1, "module must subscribe to at least one event"),
    enabled: z.boolean().optional(),
  })
  .strict();

export type AutomationModuleDef = z.infer<typeof AutomationModuleDefSchema>;

export const AutomationConfigSchema = z
  .object({
    preset: z.enum(AUTOMATION_PRESETS).default("supervised"),
    modules: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), AutomationModuleDefSchema).default({}),
  })
  .strict();

export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;

// ── Actions ──

export type AutomationAction =
  | { action: "none"; reason: string }
  | { action: "bye-and-untrack"; sessionIds: string[] }
  | { action: "set-state"; patch: Record<string, unknown> }
  | { action: "emit-event"; event: { event: string; category: string; [key: string]: unknown } }
  | { action: "shell"; cmd: string; args: string[] }
  | { action: "escalate"; reason: string; payload?: unknown };

export const AUTOMATION_ACTION_NAMES = [
  "none",
  "bye-and-untrack",
  "set-state",
  "emit-event",
  "shell",
  "escalate",
] as const;

export type AutomationActionName = (typeof AUTOMATION_ACTION_NAMES)[number];

// ── defineAutomation ──

export const DEFINE_AUTOMATION_SENTINEL = "defineAutomation(";

export function isDefineAutomation(source: string): boolean {
  return source.includes(DEFINE_AUTOMATION_SENTINEL);
}

export interface AutomationContext extends Pick<AliasContext, "mcp" | "state" | "repoRoot" | "signal"> {
  workItem: AliasContext["workItem"];
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  emit(event: { event: string; category: string; [key: string]: unknown }): void;
}

export interface AutomationDefinition {
  name: string;
  events: AutomationEventName[];
  fn: (event: MonitorEvent, ctx: AutomationContext) => AutomationAction | Promise<AutomationAction>;
}

export function defineAutomation(def: AutomationDefinition): AutomationDefinition {
  return def;
}

// ── Per-work-item overrides ──

export function parseAutomationOverrides(csv: string | undefined | null): Map<string, boolean> {
  const result = new Map<string, boolean>();
  if (!csv) return result;
  for (const part of csv.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .toLowerCase();
    if (name && (value === "true" || value === "false")) {
      result.set(name, value === "true");
    }
  }
  return result;
}

export function isModuleEnabledForItem(
  moduleName: string,
  moduleEnabled: boolean | undefined,
  preset: AutomationPreset,
  overrides: Map<string, boolean>,
): boolean {
  const presetDefaults = expandPreset(preset);
  const baseEnabled = moduleEnabled !== undefined ? moduleEnabled : (presetDefaults[moduleName] ?? false);
  const itemOverride = overrides.get(moduleName);
  return itemOverride !== undefined ? itemOverride : baseEnabled;
}

// ── Audit log entry ──

export type AutomationOutcome = "fired" | "skipped" | "errored" | "escalated";

export interface AutomationAuditEntry {
  module: string;
  outcome: AutomationOutcome;
  event: string;
  workItemId: string | undefined;
  action: AutomationAction | null;
  error: string | null;
  ts: string;
  durationMs: number;
}
