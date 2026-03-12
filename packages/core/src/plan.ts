/**
 * Plan protocol types and Zod schemas.
 *
 * Shared contract for plan-aware MCP servers to expose
 * structured workflows with steps, gates, and metrics.
 */

import { z } from "zod/v4";

// -- Enums & primitives --

export const PlanStatusValues = ["pending", "active", "gated", "complete", "aborted", "failed"] as const;

// Open union: known statuses are typed; unknown strings from newer daemons pass through
// instead of throwing, preventing CLI crashes when daemon adds new statuses.
export const PlanStatusSchema = z.enum(PlanStatusValues).or(z.string());
export type PlanStatus = (typeof PlanStatusValues)[number] | string;

// -- Core types --

export const PlanGateSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  description: z.string().optional(),
});

export type PlanGate = z.infer<typeof PlanGateSchema>;

export const PlanMetricsSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type PlanMetrics = z.infer<typeof PlanMetricsSchema>;

export const PlanStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: PlanStatusSchema,
  gates: z.array(PlanGateSchema).optional(),
  metrics: PlanMetricsSchema.optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: PlanStatusSchema,
    server: z.string(),
    steps: z.array(PlanStepSchema),
    activeStepId: z.string().optional(),
  })
  .refine(
    (p) => !p.activeStepId || p.steps.some((s) => s.id === p.activeStepId),
    "activeStepId must reference an existing step",
  );

export type Plan = z.infer<typeof PlanSchema>;

// -- Capability --

export const PlanCapabilityValues = ["list", "get", "advance", "abort", "metrics"] as const;
export type PlanCapability = (typeof PlanCapabilityValues)[number];

export const PlanCapabilitySchema = z.enum(PlanCapabilityValues);

// Array (not Set) so JSON.stringify works correctly over IPC.
export const PlanProtocolCapabilitySchema = z.object({
  capabilities: z.array(PlanCapabilitySchema),
});

export type PlanProtocolCapability = z.infer<typeof PlanProtocolCapabilitySchema>;

// -- IPC param/result schemas --

export const ListPlansParamsSchema = z.object({
  server: z.string().optional(),
});

export type ListPlansParams = z.infer<typeof ListPlansParamsSchema>;

export const ListPlansResultSchema = z.object({
  plans: z.array(PlanSchema),
});

export type ListPlansResult = z.infer<typeof ListPlansResultSchema>;

export const GetPlanParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
});

export type GetPlanParams = z.infer<typeof GetPlanParamsSchema>;

export const GetPlanResultSchema = z.object({
  plan: PlanSchema,
});

export type GetPlanResult = z.infer<typeof GetPlanResultSchema>;

export const AdvancePlanParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
  // Optional: advance the named step. If omitted, daemon advances the current active step.
  stepId: z.string().optional(),
});

export type AdvancePlanParams = z.infer<typeof AdvancePlanParamsSchema>;

export const AdvancePlanResultSchema = z.object({
  plan: PlanSchema,
});

export type AdvancePlanResult = z.infer<typeof AdvancePlanResultSchema>;

export const AbortPlanParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
  reason: z.string().optional(),
});

export type AbortPlanParams = z.infer<typeof AbortPlanParamsSchema>;

export const AbortPlanResultSchema = z.object({
  plan: PlanSchema,
});

export type AbortPlanResult = z.infer<typeof AbortPlanResultSchema>;

export const GetPlanMetricsParamsSchema = z.object({
  server: z.string(),
  planId: z.string(),
  stepId: z.string().optional(),
});

export type GetPlanMetricsParams = z.infer<typeof GetPlanMetricsParamsSchema>;

export const GetPlanMetricsResultSchema = z.object({
  metrics: PlanMetricsSchema,
});

export type GetPlanMetricsResult = z.infer<typeof GetPlanMetricsResultSchema>;
