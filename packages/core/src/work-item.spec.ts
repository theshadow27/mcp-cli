import { describe, expect, it } from "bun:test";
import {
  WORK_ITEM_PHASES,
  type WorkItemPhase,
  canTransition,
  createWorkItem,
  isStandardPhase,
  reachablePhases,
} from "./work-item";

describe("canTransition", () => {
  const allowed: [WorkItemPhase, WorkItemPhase][] = [
    ["impl", "review"],
    ["impl", "qa"],
    ["impl", "done"],
    ["review", "repair"],
    ["review", "qa"],
    ["review", "done"],
    ["repair", "review"],
    ["repair", "done"],
    ["qa", "repair"],
    ["qa", "done"],
  ];

  for (const [from, to] of allowed) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  const forbidden: [WorkItemPhase, WorkItemPhase][] = [
    ["impl", "repair"],
    ["impl", "impl"],
    ["review", "impl"],
    ["review", "review"],
    ["repair", "impl"],
    ["repair", "qa"],
    ["qa", "impl"],
    ["qa", "review"],
    ["qa", "qa"],
    ["done", "impl"],
    ["done", "review"],
    ["done", "repair"],
    ["done", "qa"],
    ["done", "done"],
  ];

  for (const [from, to] of forbidden) {
    it(`forbids ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(false);
    });
  }

  it("returns false for unknown source phase instead of throwing", () => {
    expect(canTransition("triage" as WorkItemPhase, "qa")).toBe(false);
    expect(canTransition("needs-attention" as WorkItemPhase, "done")).toBe(false);
  });

  it("returns false for unknown target phase", () => {
    expect(canTransition("impl", "triage" as WorkItemPhase)).toBe(false);
  });
});

describe("reachablePhases", () => {
  it("returns review, qa, and done from impl", () => {
    expect([...reachablePhases("impl")].sort()).toEqual(["done", "qa", "review"]);
  });

  it("returns nothing from done", () => {
    expect(reachablePhases("done")).toEqual([]);
  });

  it("returns repair, qa, done from review", () => {
    expect([...reachablePhases("review")].sort()).toEqual(["done", "qa", "repair"]);
  });

  it("returns empty array for unknown phase", () => {
    expect(reachablePhases("triage" as WorkItemPhase)).toEqual([]);
  });
});

describe("WORK_ITEM_PHASES", () => {
  it("contains all five phases in pipeline order", () => {
    expect(WORK_ITEM_PHASES).toEqual(["impl", "review", "repair", "qa", "done"]);
  });
});

describe("isStandardPhase", () => {
  it("returns true for all standard phases", () => {
    for (const phase of WORK_ITEM_PHASES) {
      expect(isStandardPhase(phase)).toBe(true);
    }
  });

  it("returns false for manifest-declared phases", () => {
    expect(isStandardPhase("triage")).toBe(false);
    expect(isStandardPhase("needs-attention")).toBe(false);
  });
});

describe("createWorkItem", () => {
  it("creates a work item with default phase", () => {
    const item = createWorkItem("pr:100");
    expect(item.id).toBe("pr:100");
    expect(item.phase).toBe("impl");
    expect(item.ciStatus).toBe("none");
    expect(item.reviewStatus).toBe("none");
    expect(item.prState).toBeNull();
    expect(item.issueNumber).toBeNull();
    expect(item.createdAt).toBeTruthy();
    expect(item.updatedAt).toBe(item.createdAt);
  });

  it("accepts a custom initial phase", () => {
    const item = createWorkItem("issue:50", "review");
    expect(item.phase).toBe("review");
  });
});
