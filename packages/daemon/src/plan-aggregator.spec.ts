import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@mcp-cli/core";
import { PLAN_LIVE_STATES, type PlanSession, aggregatePlans } from "./plan-aggregator";

// ── helpers ──

function makeSession(sessionId: string, state: PlanSession["state"]): PlanSession {
  return { sessionId, state };
}

function assistantEntry(content: Array<Record<string, unknown>>): TranscriptEntry {
  return {
    timestamp: Date.now(),
    direction: "inbound",
    message: {
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", content },
    },
  };
}

function todoWriteBlock(todos: Array<{ id: string; content: string; status: string }>) {
  return { type: "tool_use", name: "TodoWrite", input: { todos } };
}

function transcriptWithPlan(): TranscriptEntry[] {
  return [
    assistantEntry([
      todoWriteBlock([
        { id: "1", content: "Build feature", status: "in_progress" },
        { id: "2", content: "Write tests", status: "pending" },
      ]),
    ]),
  ];
}

function emptyTranscript(): TranscriptEntry[] {
  return [];
}

// ── PLAN_LIVE_STATES ──

describe("PLAN_LIVE_STATES", () => {
  test("includes active, waiting_permission, result, idle", () => {
    expect(PLAN_LIVE_STATES.has("active")).toBe(true);
    expect(PLAN_LIVE_STATES.has("waiting_permission")).toBe(true);
    expect(PLAN_LIVE_STATES.has("result")).toBe(true);
    expect(PLAN_LIVE_STATES.has("idle")).toBe(true);
  });

  test("excludes connecting, init, ended, disconnected", () => {
    expect(PLAN_LIVE_STATES.has("connecting")).toBe(false);
    expect(PLAN_LIVE_STATES.has("init")).toBe(false);
    expect(PLAN_LIVE_STATES.has("ended")).toBe(false);
    expect(PLAN_LIVE_STATES.has("disconnected")).toBe(false);
  });
});

// ── aggregatePlans ──

describe("aggregatePlans", () => {
  test("skips sessions in connecting/init states", () => {
    const sessions = [makeSession("s1", "connecting"), makeSession("s2", "init")];
    const result = aggregatePlans(sessions, () => transcriptWithPlan());
    expect(result).toEqual([]);
  });

  test("skips sessions in ended/disconnected states", () => {
    const sessions = [makeSession("s1", "ended"), makeSession("s2", "disconnected")];
    const result = aggregatePlans(sessions, () => transcriptWithPlan());
    expect(result).toEqual([]);
  });

  test("includes sessions in active/waiting_permission/result/idle states", () => {
    const sessions = [
      makeSession("s-active", "active"),
      makeSession("s-waiting", "waiting_permission"),
      makeSession("s-result", "result"),
      makeSession("s-idle", "idle"),
    ];
    const result = aggregatePlans(sessions, () => transcriptWithPlan());
    expect(result).toHaveLength(4);
  });

  test("filters mixed session states correctly", () => {
    const sessions = [
      makeSession("s1", "active"),
      makeSession("s2", "init"),
      makeSession("s3", "ended"),
      makeSession("s4", "idle"),
      makeSession("s5", "disconnected"),
    ];
    const called: string[] = [];
    const result = aggregatePlans(sessions, (id) => {
      called.push(id);
      return transcriptWithPlan();
    });
    // Only s1 (active) and s4 (idle) should be queried
    expect(called).toEqual(["s1", "s4"]);
    expect(result).toHaveLength(2);
  });

  test("a session that throws during getTranscript does not break others", () => {
    const sessions = [makeSession("s-bad", "active"), makeSession("s-good", "active")];
    const result = aggregatePlans(sessions, (id) => {
      if (id === "s-bad") throw new Error("transcript read failed");
      return transcriptWithPlan();
    });
    // s-good should still produce a plan
    expect(result).toHaveLength(1);
    expect(result[0].id).toContain("s-good");
  });

  test("returns empty array when no sessions have plan data", () => {
    const sessions = [makeSession("s1", "active"), makeSession("s2", "idle")];
    const result = aggregatePlans(sessions, () => emptyTranscript());
    expect(result).toEqual([]);
  });

  test("sorts plans by session id for deterministic ordering", () => {
    const sessions = [
      makeSession("z-session", "active"),
      makeSession("a-session", "active"),
      makeSession("m-session", "active"),
    ];
    const result = aggregatePlans(sessions, () => transcriptWithPlan());
    const ids = result.map((p) => p.id);
    // extractPlansFromTranscript prefixes session IDs with "claude-"
    expect(ids).toEqual(["claude-a-session", "claude-m-session", "claude-z-session"]);
  });
});
