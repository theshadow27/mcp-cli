import { describe, expect, it } from "bun:test";
import {
  WORK_ITEM_PHASES,
  type WorkItemPhase,
  canTransition,
  createWorkItem,
  domainScopedWorkItemId,
  isReservedPhaseStateKey,
  isStandardPhase,
  reachablePhases,
  workItemIdCandidates,
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
    ["repair", "qa"],
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

  it("returns review, qa, done from repair", () => {
    expect([...reachablePhases("repair")].sort()).toEqual(["done", "qa", "review"]);
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

describe("isReservedPhaseStateKey", () => {
  it("reserves the phase-runner-owned freshness, round, and transition sentinels", () => {
    for (const key of [
      "review_spawned_at",
      "qa_spawned_at",
      "review_round",
      "repair_round",
      "qa_fail_round",
      "previous_phase",
    ]) {
      expect(isReservedPhaseStateKey(key)).toBe(true);
    }
  });

  it("does not reserve the orchestrator-writable session-id family or general keys", () => {
    for (const key of [
      "session_id",
      "review_session_id",
      "repair_session_id",
      "qa_session_id",
      "worktree_path",
      "model",
      "provider",
      "labels",
      "scrutiny",
    ]) {
      expect(isReservedPhaseStateKey(key)).toBe(false);
    }
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

describe("domainScopedWorkItemId", () => {
  it("leaves the unassigned partition's ids byte-identical", () => {
    // The whole migration story: with no domain registered, nothing that stored a
    // work-item id anywhere has to know this function exists.
    for (const id of ["#42", "issue:42", "pr:7", "branch:fix/foo"]) {
      expect(domainScopedWorkItemId(0, id)).toBe(id);
    }
  });

  it("qualifies an id with its domain so two domains can derive the same base id", () => {
    expect(domainScopedWorkItemId(1, "issue:42")).toBe("d1:issue:42");
    expect(domainScopedWorkItemId(2, "issue:42")).toBe("d2:issue:42");
    expect(domainScopedWorkItemId(1, "issue:42")).not.toBe(domainScopedWorkItemId(2, "issue:42"));
  });

  it("is idempotent in shape — a re-scoped id nests rather than being silently rewritten", () => {
    // Documents the behaviour so a caller that double-scopes sees an obviously wrong id
    // instead of one that quietly collides with a real row.
    expect(domainScopedWorkItemId(1, domainScopedWorkItemId(1, "issue:42"))).toBe("d1:d1:issue:42");
  });
});

describe("workItemIdCandidates", () => {
  it("returns the single spelling in the unassigned partition", () => {
    expect(workItemIdCandidates(0, "#42")).toEqual(["#42"]);
  });

  it("accepts both the stored and unscoped spellings inside a domain", () => {
    expect(workItemIdCandidates(3, "#42")).toEqual(["#42", "d3:#42"]);
  });

  it("never offers another domain's spelling", () => {
    expect(workItemIdCandidates(3, "#42")).not.toContain("d1:#42");
  });
});
