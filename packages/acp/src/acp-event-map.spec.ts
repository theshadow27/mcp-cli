import { describe, expect, test } from "bun:test";
import { buildTurnResult, createAcpEventMapState, mapSessionUpdate } from "./acp-event-map";

describe("mapSessionUpdate", () => {
  test("agent_message_chunk returns session:response and accumulates text", () => {
    const state = createAcpEventMapState();
    const events = mapSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        },
      },
      state,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session:response");
    if (events[0].type === "session:response") {
      expect(events[0].text).toBe("Hello ");
    }
    expect(state.currentResponseText).toBe("Hello ");

    // Second chunk accumulates
    mapSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world!" },
        },
      },
      state,
    );
    expect(state.currentResponseText).toBe("Hello world!");
  });

  test("tool_call returns empty events", () => {
    const state = createAcpEventMapState();
    const events = mapSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          type: "toolCall",
          toolCall: { id: "tc-1", name: "Bash", input: { command: "ls" } },
        },
      },
      state,
    );
    expect(events).toHaveLength(0);
  });

  test("session_info_update tracks tokens and cost", () => {
    const state = createAcpEventMapState();
    const events = mapSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "session_info_update",
          usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 },
          cost: 0.005,
        },
      },
      state,
    );
    expect(events).toHaveLength(0);
    expect(state.totalTokens).toBe(150);
    expect(state.reasoningTokens).toBe(10);
    expect(state.cost).toBe(0.005);
  });

  test("plan_update is ignored", () => {
    const state = createAcpEventMapState();
    const events = mapSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "plan_update" } }, state);
    expect(events).toHaveLength(0);
  });

  test("unknown update type is ignored", () => {
    const state = createAcpEventMapState();
    const events = mapSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "some_future_type" } }, state);
    expect(events).toHaveLength(0);
  });

  test("missing update field returns empty", () => {
    const state = createAcpEventMapState();
    const events = mapSessionUpdate({ sessionId: "s1" }, state);
    expect(events).toHaveLength(0);
  });
});

describe("buildTurnResult", () => {
  test("builds result from accumulated state and increments turn count", () => {
    const state = createAcpEventMapState();
    state.currentResponseText = "The answer is 42";
    state.totalTokens = 200;
    state.cost = 0.01;

    const result = buildTurnResult(state);
    expect(result.result).toBe("The answer is 42");
    expect(result.tokens).toBe(200);
    expect(result.cost).toBe(0.01);
    expect(result.numTurns).toBe(1);

    // currentResponseText is reset
    expect(state.currentResponseText).toBe("");
    expect(state.numTurns).toBe(1);
  });
});
