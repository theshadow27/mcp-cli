import { describe, expect, test } from "bun:test";
import { createEventMapState, isLegacyEvent, mapApprovalToPermission, mapNotification } from "./codex-event-map";

describe("isLegacyEvent", () => {
  test("returns true for codex/event/* methods", () => {
    expect(isLegacyEvent("codex/event/token_count")).toBe(true);
    expect(isLegacyEvent("codex/event/session_configured")).toBe(true);
  });

  test("returns false for v2 methods", () => {
    expect(isLegacyEvent("turn/completed")).toBe(false);
    expect(isLegacyEvent("item/started")).toBe(false);
    expect(isLegacyEvent("thread/status/changed")).toBe(false);
  });
});

describe("mapNotification", () => {
  const sessionId = "test-session";
  const provider = "codex" as const;

  test("item/agentMessage/delta emits session:response", () => {
    const state = createEventMapState();
    const events = mapNotification(
      "item/agentMessage/delta",
      { threadId: "t1", turnId: "turn1", itemId: "item1", delta: "Hello " },
      state,
      sessionId,
      provider,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "session:response", text: "Hello " });
  });

  test("turn/completed emits session:result", () => {
    const state = createEventMapState();
    state.lastResultText = "Done!";
    state.totalTokens = 1500;

    const events = mapNotification(
      "turn/completed",
      { threadId: "t1", turnId: "turn1", status: "completed" },
      state,
      sessionId,
      provider,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "session:result",
      result: {
        result: "Done!",
        cost: null,
        tokens: 1500,
        numTurns: 1,
        diff: undefined,
      },
    });
    expect(state.numTurns).toBe(1);
  });

  test("turn/completed with failed status emits session:error", () => {
    const state = createEventMapState();
    const events = mapNotification(
      "turn/completed",
      { threadId: "t1", turnId: "turn1", status: "failed", reason: "Model error" },
      state,
      sessionId,
      provider,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "session:error",
      errors: ["Model error"],
      cost: null,
    });
  });

  test("turn/diff/updated stores diff in state", () => {
    const state = createEventMapState();
    mapNotification(
      "turn/diff/updated",
      { threadId: "t1", turnId: "turn1", diff: "--- a/foo.ts\n+++ b/foo.ts" },
      state,
      sessionId,
      provider,
    );
    expect(state.currentDiff).toBe("--- a/foo.ts\n+++ b/foo.ts");
  });

  test("thread/tokenUsage/updated updates token state", () => {
    const state = createEventMapState();
    mapNotification(
      "thread/tokenUsage/updated",
      {
        threadId: "t1",
        turnId: "turn1",
        tokenUsage: {
          total: {
            totalTokens: 2000,
            inputTokens: 1200,
            cachedInputTokens: 400,
            outputTokens: 800,
            reasoningOutputTokens: 150,
          },
          last: {
            totalTokens: 2000,
            inputTokens: 1200,
            cachedInputTokens: 400,
            outputTokens: 800,
            reasoningOutputTokens: 150,
          },
          modelContextWindow: 128000,
        },
      },
      state,
      sessionId,
      provider,
    );
    expect(state.totalTokens).toBe(2000); // input + output
    expect(state.reasoningTokens).toBe(150);
  });

  test("item/started tracks file paths", () => {
    const state = createEventMapState();
    mapNotification(
      "item/started",
      {
        threadId: "t1",
        turnId: "turn1",
        item: {
          id: "item-123",
          type: "fileChange",
          status: "inProgress",
          changes: [
            { path: "src/foo.ts", kind: "modify", diff: "" },
            { path: "src/bar.ts", kind: "add", diff: "" },
          ],
        },
      },
      state,
      sessionId,
      provider,
    );
    expect(state.itemFiles.get("item-123")).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("item/completed with agentMessage updates lastResultText", () => {
    const state = createEventMapState();
    mapNotification(
      "item/completed",
      {
        threadId: "t1",
        turnId: "turn1",
        item: {
          id: "item-456",
          type: "agentMessage",
          status: "completed",
          text: "I've created the file.",
        },
      },
      state,
      sessionId,
      provider,
    );
    expect(state.lastResultText).toBe("I've created the file.");
  });

  test("unhandled methods return empty events", () => {
    const state = createEventMapState();
    expect(mapNotification("reasoning/started", {}, state, sessionId, provider)).toEqual([]);
    expect(mapNotification("plan/updated", {}, state, sessionId, provider)).toEqual([]);
    expect(mapNotification("skills/loaded", {}, state, sessionId, provider)).toEqual([]);
  });

  test("thread/status/changed returns empty events (state machine handles it)", () => {
    const state = createEventMapState();
    const events = mapNotification(
      "thread/status/changed",
      { threadId: "t1", status: "waitingOnApproval" },
      state,
      sessionId,
      provider,
    );
    expect(events).toEqual([]);
  });

  test("turn/completed with interrupted status emits session:error", () => {
    const state = createEventMapState();
    const events = mapNotification(
      "turn/completed",
      { threadId: "t1", turnId: "turn1", status: "interrupted" },
      state,
      sessionId,
      provider,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "session:error",
      errors: ["Turn interrupted"],
      cost: null,
    });
  });

  test("turn/completed evicts itemFiles and itemCommands maps", () => {
    const state = createEventMapState();
    // Populate tracking maps as if items were started during the turn
    state.itemFiles.set("item-1", ["src/a.ts"]);
    state.itemFiles.set("item-2", ["src/b.ts", "src/c.ts"]);
    state.itemCommands.set("item-3", "npm test");
    state.itemCommands.set("item-4", "bun build");

    mapNotification(
      "turn/completed",
      { threadId: "t1", turnId: "turn1", status: "completed" },
      state,
      sessionId,
      provider,
    );

    expect(state.itemFiles.size).toBe(0);
    expect(state.itemCommands.size).toBe(0);
  });

  test("turn/completed includes diff when available", () => {
    const state = createEventMapState();
    state.currentDiff = "unified diff content";
    state.lastResultText = "Done";

    const events = mapNotification(
      "turn/completed",
      { threadId: "t1", turnId: "turn1", status: "completed" },
      state,
      sessionId,
      provider,
    );

    expect(events[0]).toHaveProperty("type", "session:result");
    if (events[0]?.type === "session:result") {
      expect(events[0].result.diff).toBe("unified diff content");
    }
  });
});

describe("mapApprovalToPermission", () => {
  test("commandExecution maps to Bash tool", () => {
    const state = createEventMapState();
    const perm = mapApprovalToPermission(
      "item/commandExecution/requestApproval",
      {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item-1",
        approvalId: "approval-1",
        command: "npm test",
        cwd: "/project",
      },
      state,
    );

    expect(perm).toEqual({
      requestId: "approval-1",
      toolName: "Bash",
      input: { command: "npm test" },
      inputSummary: "Run: npm test",
    });
  });

  test("fileChange maps to Write tool with tracked file paths", () => {
    const state = createEventMapState();
    state.itemFiles.set("item-2", ["src/foo.ts", "src/bar.ts"]);

    const perm = mapApprovalToPermission(
      "item/fileChange/requestApproval",
      {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item-2",
        approvalId: "approval-2",
      },
      state,
    );

    expect(perm).toEqual({
      requestId: "approval-2",
      toolName: "Write",
      input: { file_path: "src/foo.ts", files: ["src/foo.ts", "src/bar.ts"] },
      inputSummary: "Write: src/foo.ts, src/bar.ts",
    });
  });

  test("fileChange with unknown itemId uses 'unknown' path", () => {
    const state = createEventMapState();
    const perm = mapApprovalToPermission(
      "item/fileChange/requestApproval",
      {
        threadId: "t1",
        turnId: "turn1",
        itemId: "no-such-item",
        approvalId: "approval-3",
      },
      state,
    );

    expect(perm?.toolName).toBe("Write");
    expect(perm?.input.file_path).toBe("unknown");
    expect(perm?.inputSummary).toBe("Write: unknown file");
  });

  test("unknown approval method returns null", () => {
    const state = createEventMapState();
    expect(mapApprovalToPermission("some/other/method", {}, state)).toBeNull();
  });
});
