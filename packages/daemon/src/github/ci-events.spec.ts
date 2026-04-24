import { describe, expect, test } from "bun:test";
import { type CiEvent, computeCiTransitions, isGreenConclusion } from "./ci-events";
import type { CiCheck } from "./graphql-client";

const SUITE_ID = 1000;
const PR = 42;
const WI = "#100";
const T0 = 1_000_000;

function check(name: string, status: string, conclusion: string | null, suiteId = SUITE_ID): CiCheck {
  return { name, status, conclusion, checkSuiteId: suiteId };
}

describe("computeCiTransitions", () => {
  test("emits ci.started + ci.running on first poll with in-progress checks", () => {
    const checks = [
      check("check", "IN_PROGRESS", null),
      check("coverage", "QUEUED", null),
      check("build", "QUEUED", null),
    ];
    const { events, state } = computeCiTransitions(PR, WI, null, checks, T0);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "ci.started",
      prNumber: PR,
      workItemId: WI,
      checks: ["check", "coverage", "build"],
    });
    expect(events[1]).toEqual({
      type: "ci.running",
      prNumber: PR,
      workItemId: WI,
      inProgress: ["check", "coverage", "build"],
      completed: [],
    });
    expect(state).not.toBeNull();
    expect(state?.suiteId).toBe(SUITE_ID);
    expect(state?.emittedStarted).toBe(true);
    expect(state?.emittedFinished).toBe(false);
  });

  test("emits ci.started + ci.finished when all checks are already terminal", () => {
    const checks = [
      check("check", "COMPLETED", "SUCCESS"),
      check("coverage", "COMPLETED", "SUCCESS"),
      check("build", "COMPLETED", "SUCCESS"),
    ];
    const { events, state } = computeCiTransitions(PR, WI, null, checks, T0);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("ci.started");
    expect(events[1]).toEqual({
      type: "ci.finished",
      prNumber: PR,
      workItemId: WI,
      checks: [
        { name: "check", conclusion: "success" },
        { name: "coverage", conclusion: "success" },
        { name: "build", conclusion: "success" },
      ],
      allGreen: true,
      observedDurationMs: 0,
    });
    expect(state?.emittedFinished).toBe(true);
  });

  test("transitions from running to finished", () => {
    // First poll: started + running
    const runningChecks = [check("check", "IN_PROGRESS", null), check("build", "COMPLETED", "SUCCESS")];
    const r1 = computeCiTransitions(PR, WI, null, runningChecks, T0);

    // Second poll: all terminal
    const finishedChecks = [check("check", "COMPLETED", "SUCCESS"), check("build", "COMPLETED", "SUCCESS")];
    const r2 = computeCiTransitions(PR, WI, r1.state, finishedChecks, T0 + 60_000);

    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]).toEqual({
      type: "ci.finished",
      prNumber: PR,
      workItemId: WI,
      checks: [
        { name: "check", conclusion: "success" },
        { name: "build", conclusion: "success" },
      ],
      allGreen: true,
      observedDurationMs: 60_000,
    });
  });

  test("re-run with new suiteId resets state and emits new ci.started", () => {
    // First run completes
    const firstRunChecks = [check("check", "COMPLETED", "SUCCESS", 1000)];
    const r1 = computeCiTransitions(PR, WI, null, firstRunChecks, T0);
    expect(r1.state?.emittedFinished).toBe(true);

    // Re-run with new suiteId
    const reRunChecks = [check("check", "IN_PROGRESS", null, 2000)];
    const r2 = computeCiTransitions(PR, WI, r1.state, reRunChecks, T0 + 120_000);

    expect(r2.events).toHaveLength(2);
    expect(r2.events[0].type).toBe("ci.started");
    expect(r2.events[1].type).toBe("ci.running");
    expect(r2.state?.suiteId).toBe(2000);
    expect(r2.state?.startedAt).toBe(T0 + 120_000);
  });

  test("no duplicate ci.started on same-run re-poll", () => {
    const checks = [check("check", "IN_PROGRESS", null)];
    const r1 = computeCiTransitions(PR, WI, null, checks, T0);
    expect(r1.events.some((e) => e.type === "ci.started")).toBe(true);

    // Same suite, same state — no new ci.started
    const r2 = computeCiTransitions(PR, WI, r1.state, checks, T0 + 30_000);
    expect(r2.events.some((e) => e.type === "ci.started")).toBe(false);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].type).toBe("ci.running");
  });

  test("no duplicate ci.finished on re-poll after terminal", () => {
    const checks = [check("check", "COMPLETED", "SUCCESS")];
    const r1 = computeCiTransitions(PR, WI, null, checks, T0);
    expect(r1.state?.emittedFinished).toBe(true);

    const r2 = computeCiTransitions(PR, WI, r1.state, checks, T0 + 30_000);
    expect(r2.events).toHaveLength(0);
  });

  test("allGreen false when any check fails", () => {
    const checks = [check("check", "COMPLETED", "SUCCESS"), check("build", "COMPLETED", "FAILURE")];
    const { events } = computeCiTransitions(PR, WI, null, checks, T0);

    const finished = events.find((e) => e.type === "ci.finished");
    expect(finished).toBeDefined();
    expect((finished as Extract<CiEvent, { type: "ci.finished" }>).allGreen).toBe(false);
  });

  test("allGreen false when a check is cancelled", () => {
    const checks = [check("check", "COMPLETED", "SUCCESS"), check("build", "COMPLETED", "CANCELLED")];
    const { events } = computeCiTransitions(PR, WI, null, checks, T0);

    const finished = events.find((e) => e.type === "ci.finished");
    expect((finished as Extract<CiEvent, { type: "ci.finished" }>).allGreen).toBe(false);
  });

  test("allGreen true when checks are success or skipped", () => {
    // GitHub returns status=COMPLETED + conclusion=SKIPPED for skipped checks
    const checks = [check("check", "COMPLETED", "SUCCESS"), check("optional", "COMPLETED", "SKIPPED")];
    const { events } = computeCiTransitions(PR, WI, null, checks, T0);

    const finished = events.find((e) => e.type === "ci.finished");
    expect((finished as Extract<CiEvent, { type: "ci.finished" }>).allGreen).toBe(true);
  });

  test("returns empty events when no checks provided", () => {
    const { events, state } = computeCiTransitions(PR, WI, null, [], T0);
    expect(events).toHaveLength(0);
    expect(state).toBeNull();
  });

  test("returns empty events when no check has suiteId", () => {
    const checks = [{ name: "check", status: "IN_PROGRESS", conclusion: null, checkSuiteId: null }];
    const { events, state } = computeCiTransitions(PR, WI, null, checks, T0);
    expect(events).toHaveLength(0);
    expect(state).toBeNull();
  });

  test("running event separates in-progress from completed checks", () => {
    const checks = [
      check("check", "IN_PROGRESS", null),
      check("coverage", "COMPLETED", "SUCCESS"),
      check("build", "QUEUED", null),
    ];
    const r1 = computeCiTransitions(PR, WI, null, checks, T0);

    const running = r1.events.find((e) => e.type === "ci.running");
    expect(running).toBeDefined();
    const r = running as Extract<CiEvent, { type: "ci.running" }>;
    expect(r.inProgress).toEqual(["check", "build"]);
    expect(r.completed).toEqual(["coverage"]);
  });

  test("observedDurationMs is computed from startedAt to finished poll", () => {
    const running = [check("check", "IN_PROGRESS", null)];
    const r1 = computeCiTransitions(PR, WI, null, running, 10_000);

    const finished = [check("check", "COMPLETED", "SUCCESS")];
    const r2 = computeCiTransitions(PR, WI, r1.state, finished, 192_000);

    const ev = r2.events.find((e) => e.type === "ci.finished") as Extract<CiEvent, { type: "ci.finished" }>;
    expect(ev.observedDurationMs).toBe(182_000);
  });

  test("picks highest suiteId from mixed-suite checks (multi-workflow repos)", () => {
    // Coverage workflow (suiteId 999) + CI workflow (suiteId 1000) mixed in response
    const checks = [check("coverage", "COMPLETED", "SUCCESS", 999), check("check", "IN_PROGRESS", null, 1000)];
    const { state } = computeCiTransitions(PR, WI, null, checks, T0);
    expect(state?.suiteId).toBe(1000); // max, not first
  });

  test("detects re-run when new suiteId appears mixed with old-suite checks", () => {
    // First run finishes with suiteId 1000
    const firstRun = [check("check", "COMPLETED", "SUCCESS", 1000)];
    const r1 = computeCiTransitions(PR, WI, null, firstRun, T0);
    expect(r1.state?.emittedFinished).toBe(true);

    // Re-run: CI has new suite 2000, but coverage still reports old suite 999 first
    const reRunMixed = [check("coverage", "COMPLETED", "SUCCESS", 999), check("check", "IN_PROGRESS", null, 2000)];
    const r2 = computeCiTransitions(PR, WI, r1.state, reRunMixed, T0 + 60_000);

    expect(r2.state?.suiteId).toBe(2000);
    expect(r2.events.some((e) => e.type === "ci.started")).toBe(true);
  });

  test("null conclusion defaults to failure in ci.finished", () => {
    const checks = [check("check", "COMPLETED", null)];
    const { events } = computeCiTransitions(PR, WI, null, checks, T0);

    const finished = events.find((e) => e.type === "ci.finished") as Extract<CiEvent, { type: "ci.finished" }>;
    expect(finished.checks[0].conclusion).toBe("failure");
    expect(finished.allGreen).toBe(false);
  });
});

describe("isGreenConclusion", () => {
  test("success is green", () => expect(isGreenConclusion("success")).toBe(true));
  test("skipped is green", () => expect(isGreenConclusion("skipped")).toBe(true));
  test("neutral is green", () => expect(isGreenConclusion("neutral")).toBe(true));
  test("failure is not green", () => expect(isGreenConclusion("failure")).toBe(false));
  test("cancelled is not green", () => expect(isGreenConclusion("cancelled")).toBe(false));
  test("timed_out is not green", () => expect(isGreenConclusion("timed_out")).toBe(false));
});
