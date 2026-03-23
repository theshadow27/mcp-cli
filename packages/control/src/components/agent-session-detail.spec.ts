import { describe, expect, it } from "bun:test";
import { type TranscriptEntry, entryKey, formatFullEntry, summarizeEntry } from "./agent-session-detail";

function makeEntry(overrides: Partial<TranscriptEntry> & { message: Record<string, unknown> }): TranscriptEntry {
  return { timestamp: Date.now(), direction: "inbound", ...overrides };
}

describe("entryKey", () => {
  it("combines timestamp and direction", () => {
    expect(entryKey({ timestamp: 123, direction: "inbound", message: {} })).toBe("123-inbound");
  });
});

describe("summarizeEntry", () => {
  it("truncates long assistant text to 120 visual chars", () => {
    const longText = "a".repeat(200);
    const entry = makeEntry({
      direction: "outbound",
      message: {
        type: "assistant",
        message: { content: [{ type: "text", text: longText }] },
      },
    });
    const result = summarizeEntry(entry);
    expect(result.endsWith("...")).toBe(true);
    expect(Bun.stringWidth(result)).toBeLessThanOrEqual(120);
  });

  it("preserves short assistant text", () => {
    const entry = makeEntry({
      direction: "outbound",
      message: {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello world" }] },
      },
    });
    expect(summarizeEntry(entry)).toBe("hello world");
  });

  it("handles ANSI codes in assistant text without corruption", () => {
    // 110 visible chars + ANSI codes pushes .length well over 120 but visual width is under
    const ansiText = `\x1b[31m${"x".repeat(110)}\x1b[0m`;
    const entry = makeEntry({
      direction: "outbound",
      message: {
        type: "assistant",
        message: { content: [{ type: "text", text: ansiText }] },
      },
    });
    const result = summarizeEntry(entry);
    // Should NOT be truncated — visual width is 110, under 120
    expect(result).toBe(ansiText);
  });

  it("truncates ANSI text that exceeds 120 visual chars", () => {
    const ansiText = `\x1b[31m${"x".repeat(200)}\x1b[0m`;
    const entry = makeEntry({
      direction: "outbound",
      message: {
        type: "assistant",
        message: { content: [{ type: "text", text: ansiText }] },
      },
    });
    const result = summarizeEntry(entry);
    expect(result.endsWith("...")).toBe(true);
    // The sliced portion should be 117 visual chars + "..."
    expect(Bun.stringWidth(result)).toBeLessThanOrEqual(120);
  });

  it("summarizes tool_use entries", () => {
    const entry = makeEntry({
      direction: "outbound",
      message: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/foo/bar.ts" } }],
        },
      },
    });
    expect(summarizeEntry(entry)).toBe("[Read: /foo/bar.ts]");
  });

  it("truncates long result text", () => {
    const longResult = "r".repeat(200);
    const entry = makeEntry({ message: { type: "result", result: longResult } });
    const result = summarizeEntry(entry);
    expect(result.endsWith("...")).toBe(true);
    expect(Bun.stringWidth(result)).toBeLessThanOrEqual(120);
  });

  it("returns [result] for empty result", () => {
    const entry = makeEntry({ message: { type: "result", result: "" } });
    expect(summarizeEntry(entry)).toBe("[result]");
  });
});

describe("formatFullEntry", () => {
  it("formats assistant text blocks", () => {
    const entry = makeEntry({
      direction: "outbound",
      message: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      },
    });
    expect(formatFullEntry(entry)).toBe("hello\nworld");
  });

  it("formats result entries", () => {
    const entry = makeEntry({ message: { type: "result", result: "done" } });
    expect(formatFullEntry(entry)).toBe("done");
  });

  it("falls back to JSON for unknown types", () => {
    const entry = makeEntry({ message: { type: "custom", data: 42 } });
    expect(formatFullEntry(entry)).toBe(JSON.stringify({ type: "custom", data: 42 }, null, 2));
  });
});
