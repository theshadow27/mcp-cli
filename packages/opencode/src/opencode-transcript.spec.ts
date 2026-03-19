import { describe, expect, test } from "bun:test";
import { assistantEntry, createTranscriptState, processEvent, userEntry } from "./opencode-transcript";

describe("processEvent", () => {
  test("tool running creates tool_use entry", () => {
    const state = createTranscriptState();
    const entries = processEvent(
      {
        type: "message.part.updated",
        data: {
          part: { type: "tool", id: "t1", name: "Bash", state: "running", input: { command: "ls" } },
        },
      },
      state,
      1000,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("tool_use");
    expect(entries[0].tool).toBe("Bash");
    expect(entries[0].input).toEqual({ command: "ls" });
    expect(entries[0].timestamp).toBe(1000);
  });

  test("tool completed creates tool_result entry with pending tool name", () => {
    const state = createTranscriptState();
    // First register a running tool
    processEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "tool", id: "t1", name: "Bash", state: "running" } },
      },
      state,
    );

    const entries = processEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "tool", id: "t1", name: "Bash", state: "completed", output: "file.txt\n" } },
      },
      state,
      2000,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("tool_result");
    expect(entries[0].tool).toBe("Bash");
    expect(entries[0].content).toBe("file.txt\n");
    expect(entries[0].timestamp).toBe(2000);
  });

  test("tool error creates tool_result entry", () => {
    const state = createTranscriptState();
    processEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "tool", id: "t2", name: "Read", state: "running" } },
      },
      state,
    );

    const entries = processEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "tool", id: "t2", name: "Read", state: "error", output: "not found" } },
      },
      state,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("tool_result");
    expect(entries[0].tool).toBe("Read");
    expect(entries[0].content).toBe("not found");
  });

  test("tool completed without pending call uses event name", () => {
    const state = createTranscriptState();
    const entries = processEvent(
      {
        type: "message.part.updated",
        data: { part: { type: "tool", id: "orphan-1", name: "Grep", state: "completed", output: "output" } },
      },
      state,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe("Grep");
  });

  test("non message.part.updated events return empty", () => {
    const state = createTranscriptState();
    expect(processEvent({ type: "session.status", data: { status: "idle" } }, state)).toHaveLength(0);
    expect(processEvent({ type: "session.error", data: {} }, state)).toHaveLength(0);
  });

  test("text part type returns empty (handled by event map)", () => {
    const state = createTranscriptState();
    const entries = processEvent(
      { type: "message.part.updated", data: { part: { type: "text", text: "hello" } } },
      state,
    );
    expect(entries).toHaveLength(0);
  });

  test("missing part returns empty", () => {
    const state = createTranscriptState();
    const entries = processEvent({ type: "message.part.updated", data: {} }, state);
    expect(entries).toHaveLength(0);
  });
});

describe("assistantEntry / userEntry", () => {
  test("assistantEntry creates correct shape", () => {
    const entry = assistantEntry("hello", 1000);
    expect(entry.role).toBe("assistant");
    expect(entry.content).toBe("hello");
    expect(entry.timestamp).toBe(1000);
  });

  test("userEntry creates correct shape", () => {
    const entry = userEntry("prompt text", 2000);
    expect(entry.role).toBe("user");
    expect(entry.content).toBe("prompt text");
    expect(entry.timestamp).toBe(2000);
  });
});
