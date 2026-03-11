import { describe, expect, test } from "bun:test";
import { itemToTranscript } from "./codex-transcript";
import type { ThreadItem } from "./schemas";

const ts = 1710000000000;

describe("itemToTranscript", () => {
  test("userMessage → user entry", () => {
    const item: ThreadItem = { id: "1", type: "userMessage", status: "completed", text: "Hello" };
    const entries = itemToTranscript(item, ts);
    expect(entries).toEqual([{ role: "user", content: "Hello", timestamp: ts }]);
  });

  test("agentMessage → assistant entry", () => {
    const item: ThreadItem = {
      id: "2",
      type: "agentMessage",
      status: "completed",
      text: "I'll help you with that.",
      phase: "commentary",
    };
    const entries = itemToTranscript(item, ts);
    expect(entries).toEqual([{ role: "assistant", content: "I'll help you with that.", timestamp: ts }]);
  });

  test("commandExecution → tool_use + tool_result pair", () => {
    const item: ThreadItem = {
      id: "3",
      type: "commandExecution",
      status: "completed",
      command: "npm test",
      cwd: "/project",
      exitCode: 0,
      aggregatedOutput: "All tests passed",
      durationMs: 1234,
    };
    const entries = itemToTranscript(item, ts);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      role: "tool_use",
      tool: "Bash",
      content: "npm test",
      input: { command: "npm test" },
      timestamp: ts,
    });
    expect(entries[1]).toEqual({
      role: "tool_result",
      tool: "Bash",
      content: "All tests passed",
      exitCode: 0,
      durationMs: 1234,
      timestamp: ts,
    });
  });

  test("fileChange → tool_use + tool_result pair", () => {
    const item: ThreadItem = {
      id: "4",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/foo.ts", kind: "modify", diff: "--- a/src/foo.ts\n+++ b/src/foo.ts" },
        { path: "src/bar.ts", kind: "add", diff: "+new file" },
      ],
    };
    const entries = itemToTranscript(item, ts);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      role: "tool_use",
      tool: "Write",
      content: "src/foo.ts, src/bar.ts",
      input: { files: ["src/foo.ts", "src/bar.ts"] },
      timestamp: ts,
    });
    expect(entries[1]).toEqual({
      role: "tool_result",
      tool: "Write",
      content: "Updated 2 file(s)",
      diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n+new file",
      timestamp: ts,
    });
  });

  test("reasoning → empty (not transcribed)", () => {
    const item: ThreadItem = { id: "5", type: "reasoning", status: "completed" };
    expect(itemToTranscript(item, ts)).toEqual([]);
  });

  test("enteredReviewMode → empty (not transcribed)", () => {
    const item: ThreadItem = { id: "6", type: "enteredReviewMode", status: "completed" };
    expect(itemToTranscript(item, ts)).toEqual([]);
  });

  test("handles missing optional fields gracefully", () => {
    const item: ThreadItem = { id: "7", type: "agentMessage", status: "completed" };
    const entries = itemToTranscript(item, ts);
    expect(entries[0]?.content).toBe("");
  });

  test("commandExecution with no output", () => {
    const item: ThreadItem = {
      id: "8",
      type: "commandExecution",
      status: "completed",
      command: "true",
    };
    const entries = itemToTranscript(item, ts);
    expect(entries[1]?.content).toBe("");
    expect(entries[1]?.exitCode).toBeUndefined();
  });

  test("fileChange with no changes", () => {
    const item: ThreadItem = { id: "9", type: "fileChange", status: "completed" };
    const entries = itemToTranscript(item, ts);
    expect(entries[0]?.content).toBe("");
    expect(entries[1]?.content).toBe("Updated 0 file(s)");
  });

  test("uses current time when no timestamp provided", () => {
    const item: ThreadItem = { id: "10", type: "userMessage", status: "completed", text: "hi" };
    const before = Date.now();
    const entries = itemToTranscript(item);
    const after = Date.now();
    expect(entries[0]?.timestamp).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.timestamp).toBeLessThanOrEqual(after);
  });
});
