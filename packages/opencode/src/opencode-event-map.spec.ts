import { describe, expect, test } from "bun:test";
import { buildTurnResult, createOpenCodeEventMapState, mapSseEvent } from "./opencode-event-map";

describe("mapSseEvent", () => {
  test("message.part.updated with text returns session:response and accumulates", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "text", text: "Hello " } },
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
    mapSseEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "text", text: "world!" } },
      },
      state,
    );
    expect(state.currentResponseText).toBe("Hello world!");
  });

  test("message.part.updated with tool returns empty events", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "tool", id: "t1", name: "Bash", state: "running" } },
      },
      state,
    );
    expect(events).toHaveLength(0);
  });

  test("message.part.updated with step-finish tracks tokens and cost", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent(
      {
        type: "message.part.updated",
        data: {
          part: {
            type: "step-finish",
            tokens: { input: 100, output: 50, reasoning: 10 },
            cost: 0.005,
          },
        },
      },
      state,
    );
    expect(events).toHaveLength(0);
    expect(state.totalTokens).toBe(150);
    expect(state.reasoningTokens).toBe(10);
    expect(state.cost).toBe(0.005);
  });

  test("message.part.delta accumulates streaming text", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent(
      {
        type: "message.part.delta",
        data: { delta: "chunk" },
      },
      state,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session:response");
    expect(state.currentResponseText).toBe("chunk");
  });

  test("session.error returns session:error event", () => {
    const state = createOpenCodeEventMapState();
    state.cost = 0.01;
    const events = mapSseEvent(
      {
        type: "session.error",
        data: { message: "Something went wrong" },
      },
      state,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session:error");
    if (events[0].type === "session:error") {
      expect(events[0].errors).toEqual(["Something went wrong"]);
      expect(events[0].cost).toBe(0.01);
    }
  });

  test("session.status returns empty events", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent({ type: "session.status", data: { status: "idle" } }, state);
    expect(events).toHaveLength(0);
  });

  test("session.diff returns empty events", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent({ type: "session.diff", data: { diff: "some diff" } }, state);
    expect(events).toHaveLength(0);
  });

  test("permission events return empty events (handled by session)", () => {
    const state = createOpenCodeEventMapState();
    expect(mapSseEvent({ type: "permission.asked", data: {} }, state)).toHaveLength(0);
    expect(mapSseEvent({ type: "permission.replied", data: {} }, state)).toHaveLength(0);
  });

  test("unknown event type is ignored", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent({ type: "some_future_type", data: {} }, state);
    expect(events).toHaveLength(0);
  });

  test("missing part field returns empty", () => {
    const state = createOpenCodeEventMapState();
    const events = mapSseEvent({ type: "message.part.updated", data: {} }, state);
    expect(events).toHaveLength(0);
  });
});

describe("buildTurnResult", () => {
  test("builds result from accumulated state and increments turn count", () => {
    const state = createOpenCodeEventMapState();
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

  test("cost accumulates across step-finish events", () => {
    const state = createOpenCodeEventMapState();
    mapSseEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "step-finish", tokens: { input: 10, output: 5 }, cost: 0.001 } },
      },
      state,
    );
    mapSseEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "step-finish", tokens: { input: 20, output: 10 }, cost: 0.002 } },
      },
      state,
    );
    expect(state.cost).toBe(0.003);
    expect(state.totalTokens).toBe(45);
  });
});
