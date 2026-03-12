/**
 * Plan protocol types and Zod schemas.
 *
 * Shared contract for plan-aware MCP servers to expose
 * structured workflows with steps, gates, and metrics.
 */

import { z } from "zod/v4";

// -- Enums & primitives --

export const PlanStatusValues = ["pending", "active", "gated", "complete", "aborted"] as const;
export type PlanStatus = (typeof PlanStatusValues)[number];

export const PlanStatusSchema = z.enum(PlanStatusValues);

// -- Core types --

export interface PlanGate {
  name: string;
  passed: boolean;
  description?: string;
}

export const PlanGateSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  description: z.string().optional(),
});

export type PlanMetrics = Record<string, string | number>;

export const PlanMetricsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export interface PlanStep {
  id: string;
  name: string;
  status: PlanStatus;
  gates?: PlanGate[];
  metrics?: PlanMetrics;
}

export const PlanStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: PlanStatusSchema,
  gates: z.array(PlanGateSchema).optional(),
  metrics: PlanMetricsSchema.optional(),
});

export interface Plan {
  id: string;
  name: string;
  status: PlanStatus;
  server: string;
  steps: PlanStep[];
  activeStepId?: string;
}

export const PlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: PlanStatusSchema,
  server: z.string(),
  steps: z.array(PlanStepSchema),
  activeStepId: z.string().optional(),
});

// -- Capability --

export const PlanCapabilityValues = ["list", "get", "advance", "abort", "metrics"] as const;
export type PlanCapability = (typeof PlanCapabilityValues)[number];

export const PlanCapabilitySchema = z.enum(PlanCapabilityValues);

export interface PlanProtocolCapability {
  capabilities: Set<PlanCapability>;
}

// -- IPC param/result schemas --

export const ListPlansResultSchema = z.object({
  plans: z.array(PlanSchema),
});

export interface ListPlansResult {
  plans: Plan[];
}

export const GetPlanParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
});

export const GetPlanResultSchema = z.object({
  plan: PlanSchema,
});

export interface GetPlanResult {
  plan: Plan;
}

export const AdvancePlanParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
  stepId: z.string().optional(),
});

export const AbortPlanParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
  reason: z.string().optional(),
});

export const GetPlanMetricsParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
  stepId: z.string().optional(),
});

export const GetPlanMetricsResultSchema = z.object({
  metrics: PlanMetricsSchema,
});

export interface GetPlanMetricsResult {
  metrics: PlanMetrics;
}
