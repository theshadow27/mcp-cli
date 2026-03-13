import { describe, expect, test } from "bun:test";
import {
  AbortPlanParamsSchema,
  AbortPlanResultSchema,
  AdvancePlanParamsSchema,
  AdvancePlanResultSchema,
  GetPlanMetricsParamsSchema,
  GetPlanMetricsResultSchema,
  GetPlanParamsSchema,
  GetPlanResultSchema,
  ListPlansParamsSchema,
  ListPlansResultSchema,
  PlanCapabilitySchema,
  PlanGateSchema,
  PlanMetricsSchema,
  PlanProtocolCapabilitySchema,
  PlanSchema,
  PlanStatusSchema,
  PlanStepSchema,
} from "./plan";

describe("PlanStatusSchema", () => {
  test("accepts valid statuses", () => {
    for (const s of ["pending", "active", "gated", "complete", "aborted", "failed"] as const) {
      expect(PlanStatusSchema.parse(s)).toBe(s);
    }
  });

  test("accepts unknown status strings (forward compat)", () => {
    expect(PlanStatusSchema.parse("paused")).toBe("paused");
    expect(PlanStatusSchema.parse("running")).toBe("running");
  });

  test("rejects non-string values", () => {
    expect(() => PlanStatusSchema.parse(42)).toThrow();
    expect(() => PlanStatusSchema.parse(null)).toThrow();
  });
});

describe("PlanGateSchema", () => {
  test("parses minimal gate", () => {
    const gate = PlanGateSchema.parse({ name: "approval", passed: false });
    expect(gate).toEqual({ name: "approval", passed: false });
  });

  test("parses gate with description", () => {
    const gate = PlanGateSchema.parse({
      name: "review",
      passed: true,
      description: "Code review completed",
    });
    expect(gate.description).toBe("Code review completed");
  });
});

describe("PlanMetricsSchema", () => {
  test("accepts string and number values", () => {
    const metrics = PlanMetricsSchema.parse({ duration: 42, status: "ok" });
    expect(metrics).toEqual({ duration: 42, status: "ok" });
  });

  test("rejects boolean values", () => {
    expect(() => PlanMetricsSchema.parse({ flag: true })).toThrow();
  });
});

describe("PlanStepSchema", () => {
  test("parses minimal step", () => {
    const step = PlanStepSchema.parse({ id: "s1", name: "Build", status: "pending" });
    expect(step).toEqual({ id: "s1", name: "Build", status: "pending" });
  });

  test("parses step with gates and metrics", () => {
    const step = PlanStepSchema.parse({
      id: "s2",
      name: "Deploy",
      status: "gated",
      gates: [{ name: "tests", passed: true }],
      metrics: { duration: 120 },
    });
    expect(step.gates).toHaveLength(1);
    expect(step.metrics).toEqual({ duration: 120 });
  });
});

describe("PlanSchema", () => {
  test("parses full plan", () => {
    const plan = PlanSchema.parse({
      id: "p1",
      name: "Release",
      status: "active",
      server: "ci-server",
      steps: [
        { id: "s1", name: "Build", status: "complete" },
        { id: "s2", name: "Test", status: "active" },
      ],
      activeStepId: "s2",
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.activeStepId).toBe("s2");
  });

  test("parses plan without activeStepId", () => {
    const plan = PlanSchema.parse({
      id: "p2",
      name: "Setup",
      status: "pending",
      server: "local",
      steps: [],
    });
    expect(plan.activeStepId).toBeUndefined();
  });

  test("rejects activeStepId that doesn't reference an existing step", () => {
    expect(() =>
      PlanSchema.parse({
        id: "p3",
        name: "Bad",
        status: "active",
        server: "local",
        steps: [{ id: "s1", name: "Build", status: "active" }],
        activeStepId: "step-999",
      }),
    ).toThrow("activeStepId must reference an existing step");
  });

  test("allows activeStepId matching a step id", () => {
    expect(() =>
      PlanSchema.parse({
        id: "p4",
        name: "Ok",
        status: "active",
        server: "local",
        steps: [{ id: "s1", name: "Build", status: "active" }],
        activeStepId: "s1",
      }),
    ).not.toThrow();
  });
});

describe("PlanCapabilitySchema", () => {
  test("accepts valid capabilities", () => {
    for (const c of ["list", "get", "advance", "abort", "metrics"] as const) {
      expect(PlanCapabilitySchema.parse(c)).toBe(c);
    }
  });
});

describe("PlanProtocolCapabilitySchema", () => {
  test("parses capability array", () => {
    const cap = PlanProtocolCapabilitySchema.parse({ capabilities: ["list", "get"] });
    expect(cap.capabilities).toEqual(["list", "get"]);
  });

  test("round-trips through JSON.stringify/parse", () => {
    const cap = { capabilities: ["list", "get", "advance"] as const };
    const serialized = JSON.stringify(cap);
    const parsed = PlanProtocolCapabilitySchema.parse(JSON.parse(serialized));
    expect(parsed.capabilities).toEqual(["list", "get", "advance"]);
  });

  test("rejects non-array", () => {
    expect(() => PlanProtocolCapabilitySchema.parse({ capabilities: "list" })).toThrow();
  });
});

describe("IPC param/result schemas", () => {
  test("ListPlansParamsSchema — no filter", () => {
    const params = ListPlansParamsSchema.parse({});
    expect(params.server).toBeUndefined();
    expect(params.limit).toBeUndefined();
    expect(params.cursor).toBeUndefined();
  });

  test("ListPlansParamsSchema — server filter", () => {
    const params = ListPlansParamsSchema.parse({ server: "ci" });
    expect(params.server).toBe("ci");
  });

  test("ListPlansParamsSchema — pagination params", () => {
    const params = ListPlansParamsSchema.parse({ server: "ci", limit: 10, cursor: "abc123" });
    expect(params.server).toBe("ci");
    expect(params.limit).toBe(10);
    expect(params.cursor).toBe("abc123");
  });

  test("ListPlansResultSchema", () => {
    const result = ListPlansResultSchema.parse({
      plans: [{ id: "p1", name: "X", status: "pending", server: "s", steps: [] }],
    });
    expect(result.plans).toHaveLength(1);
    expect(result.cursor).toBeUndefined();
  });

  test("ListPlansResultSchema — with cursor", () => {
    const result = ListPlansResultSchema.parse({
      plans: [{ id: "p1", name: "X", status: "pending", server: "s", steps: [] }],
      cursor: "next-page",
    });
    expect(result.plans).toHaveLength(1);
    expect(result.cursor).toBe("next-page");
  });

  test("GetPlanParamsSchema", () => {
    const params = GetPlanParamsSchema.parse({ server: "ci", planId: "p1" });
    expect(params.server).toBe("ci");
    expect(params.planId).toBe("p1");
  });

  test("GetPlanResultSchema", () => {
    const result = GetPlanResultSchema.parse({
      plan: { id: "p1", name: "X", status: "active", server: "s", steps: [] },
    });
    expect(result.plan.id).toBe("p1");
  });

  test("AdvancePlanParamsSchema", () => {
    const params = AdvancePlanParamsSchema.parse({ server: "ci", planId: "p1" });
    expect(params.stepId).toBeUndefined();

    const params2 = AdvancePlanParamsSchema.parse({ server: "ci", planId: "p1", stepId: "s1" });
    expect(params2.stepId).toBe("s1");
  });

  test("AdvancePlanResultSchema", () => {
    const result = AdvancePlanResultSchema.parse({
      plan: { id: "p1", name: "X", status: "active", server: "s", steps: [] },
    });
    expect(result.plan.id).toBe("p1");
  });

  test("AbortPlanParamsSchema", () => {
    const params = AbortPlanParamsSchema.parse({ server: "ci", planId: "p1", reason: "timeout" });
    expect(params.reason).toBe("timeout");
  });

  test("AbortPlanResultSchema", () => {
    const result = AbortPlanResultSchema.parse({
      plan: { id: "p1", name: "X", status: "aborted", server: "s", steps: [] },
    });
    expect(result.plan.status).toBe("aborted");
  });

  test("GetPlanMetricsParamsSchema", () => {
    const params = GetPlanMetricsParamsSchema.parse({ server: "ci", planId: "p1" });
    expect(params.stepId).toBeUndefined();
  });

  test("GetPlanMetricsResultSchema", () => {
    const result = GetPlanMetricsResultSchema.parse({ metrics: { calls: 5, avg: 1.2 } });
    expect(result.metrics).toEqual({ calls: 5, avg: 1.2 });
  });
});
