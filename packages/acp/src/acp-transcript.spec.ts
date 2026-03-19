import { describe, expect, test } from "bun:test";
import { assistantEntry, createTranscriptState, processUpdate, userEntry } from "./acp-transcript";

describe("processUpdate", () => {
  test("tool_call creates tool_use entry", () => {
    const state = createTranscriptState();
    const entries = processUpdate(
      {
        sessionUpdate: "tool_call",
        type: "toolCall",
        toolCall: { id: "tc-1", name: "Bash", input: { command: "ls" } },
      },
      state,
      1000,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("tool_use");
    expect(entries[0].tool).toBe("Bash");
    expect(entries[0].input).toEqual({ command: "ls" });
  });

  test("tool_result creates tool_result entry with pending tool name", () => {
    const state = createTranscriptState();
    // First register a tool call
    processUpdate(
      {
        sessionUpdate: "tool_call",
        type: "toolCall",
        toolCall: { id: "tc-1", name: "Bash", input: { command: "ls" } },
      },
      state,
    );

    const entries = processUpdate(
      {
        sessionUpdate: "tool_result",
        type: "toolResult",
        toolResult: { id: "tc-1", output: "file.txt\n" },
      },
      state,
      2000,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("tool_result");
    expect(entries[0].tool).toBe("Bash");
    expect(entries[0].content).toBe("file.txt\n");
  });

  test("tool_result without pending call still creates entry", () => {
    const state = createTranscriptState();
    const entries = processUpdate(
      {
        sessionUpdate: "tool_result",
        type: "toolResult",
        toolResult: { id: "orphan-1", output: "output" },
      },
      state,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBeUndefined();
  });

  test("agent_message_chunk returns empty (handled by event map)", () => {
    const state = createTranscriptState();
    const entries = processUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      state,
    );
    expect(entries).toHaveLength(0);
  });

  test("unknown sessionUpdate returns empty", () => {
    const state = createTranscriptState();
    const entries = processUpdate({ sessionUpdate: "something_new" }, state);
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
