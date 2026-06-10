import { describe, expect, test } from "bun:test";
import { type GhLabelEvent, type VerdictContext, validateVerdictLabel } from "../.claude/phases/phase-types";

function makeCtx(overrides: Partial<VerdictContext> = {}): VerdictContext {
  return {
    prAuthor: "bot-user",
    roundStartedAt: new Date("2026-06-09T10:00:00Z").getTime(),
    headCommitDate: "2026-06-09T09:50:00Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<GhLabelEvent> = {}): GhLabelEvent {
  return {
    actor: "bot-user",
    label: "review:pass",
    created_at: "2026-06-09T10:05:00Z",
    ...overrides,
  };
}

describe("validateVerdictLabel (#2652)", () => {
  test("accepts a valid label event (after spawn and head commit)", () => {
    const result = validateVerdictLabel("review:pass", [makeEvent()], makeCtx());
    expect(result.valid).toBe(true);
  });

  test("fail closed: rejects when no matching labeled event exists", () => {
    const result = validateVerdictLabel("review:pass", [], makeCtx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/no labeled event found/);
  });

  test("fail closed: rejects when only events for a different label exist", () => {
    const result = validateVerdictLabel("review:pass", [makeEvent({ label: "qa:pass" })], makeCtx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/no labeled event found/);
  });

  test("guard (b): rejects stale label predating session spawn", () => {
    const stale = makeEvent({ created_at: "2026-06-09T09:55:00Z" });
    const result = validateVerdictLabel("review:pass", [stale], makeCtx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/stale verdict/);
  });

  test("guard (c): rejects label predating head commit", () => {
    const ctx = makeCtx({ headCommitDate: "2026-06-09T10:10:00Z" });
    const event = makeEvent({ created_at: "2026-06-09T10:05:00Z" });
    const result = validateVerdictLabel("review:pass", [event], ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/verdict on stale code/);
  });

  test("fail closed: rejects unparseable event timestamp", () => {
    const bad = makeEvent({ created_at: "not-a-date" });
    const result = validateVerdictLabel("review:pass", [bad], makeCtx());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/unparseable timestamp/);
  });

  test("fail closed: rejects unparseable head commit date", () => {
    const ctx = makeCtx({ headCommitDate: "garbage" });
    const result = validateVerdictLabel("review:pass", [makeEvent()], ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/unparseable head commit date/);
  });

  test("uses the most recent matching event when multiple exist", () => {
    const old = makeEvent({ created_at: "2026-06-09T09:55:00Z" });
    const fresh = makeEvent({ created_at: "2026-06-09T10:05:00Z" });
    const result = validateVerdictLabel("review:pass", [old, fresh], makeCtx());
    expect(result.valid).toBe(true);
  });

  test("guard (a) inert: returns actorNote when actor matches PR author", () => {
    const result = validateVerdictLabel(
      "review:pass",
      [makeEvent({ actor: "bot-user" })],
      makeCtx({ prAuthor: "bot-user" }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.actorNote).toMatch(/single-identity/);
  });

  test("guard (a) inert: no actorNote when actor differs from PR author", () => {
    const result = validateVerdictLabel(
      "review:pass",
      [makeEvent({ actor: "reviewer-bot" })],
      makeCtx({ prAuthor: "impl-bot" }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.actorNote).toBeUndefined();
  });

  test("works with qa:pass labels", () => {
    const event = makeEvent({ label: "qa:pass" });
    const result = validateVerdictLabel("qa:pass", [event], makeCtx());
    expect(result.valid).toBe(true);
  });

  test("works with qa:fail labels", () => {
    const event = makeEvent({ label: "qa:fail" });
    const result = validateVerdictLabel("qa:fail", [event], makeCtx());
    expect(result.valid).toBe(true);
  });

  test("guard (c): label exactly at head commit time is rejected (must be strictly after)", () => {
    const ctx = makeCtx({ headCommitDate: "2026-06-09T10:05:00Z" });
    const event = makeEvent({ created_at: "2026-06-09T10:05:00Z" });
    const result = validateVerdictLabel("review:pass", [event], ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejection).toMatch(/verdict on stale code/);
  });

  test("guard (b): label exactly at session spawn time is accepted (not strictly after)", () => {
    const exactTime = new Date("2026-06-09T10:00:00Z").toISOString();
    const event = makeEvent({ created_at: exactTime });
    const result = validateVerdictLabel("review:pass", [event], makeCtx());
    expect(result.valid).toBe(true);
  });
});
