import { describe, expect, test } from "bun:test";
import { type TranscriptEntry, compactifyEntry } from "./ws-server";

function entry(type: string, direction: "inbound" | "outbound", extra: Record<string, unknown> = {}): TranscriptEntry {
  return { timestamp: 1710600000000, direction, message: { type, ...extra } };
}

describe("compactifyEntry", () => {
  test("user message extracts text content", () => {
    const e = entry("user", "outbound", {
      message: { content: "Hello world" },
    });
    const c = compactifyEntry(e);
    expect(c).toEqual({ timestamp: 1710600000000, role: "user", content: "Hello world" });
  });

  test("assistant message with content blocks", () => {
    const e = entry("assistant", "inbound", {
      message: {
        content: [
          { type: "text", text: "Thinking about it..." },
          { type: "tool_use", name: "Read", id: "tu_123", input: { file_path: "/foo" } },
        ],
      },
    });
    const c = compactifyEntry(e);
    expect(c.role).toBe("assistant");
    expect(c.content).toBe("Thinking about it... [tool_use: Read]");
    expect(c.tool).toBe("Read");
  });

  test("result message extracts result field", () => {
    const e = entry("result", "inbound", { result: "Operation succeeded" });
    const c = compactifyEntry(e);
    expect(c).toEqual({ timestamp: 1710600000000, role: "result", content: "Operation succeeded" });
  });

  test("truncates content over 200 chars", () => {
    const longText = "x".repeat(300);
    const e = entry("user", "outbound", { message: { content: longText } });
    const c = compactifyEntry(e);
    expect(c.content?.length).toBe(201); // 200 + "…"
    expect(c.content?.endsWith("…")).toBe(true);
  });

  test("system message has null content", () => {
    const e = entry("system", "inbound");
    const c = compactifyEntry(e);
    expect(c.role).toBe("system");
    expect(c.content).toBeNull();
  });

  test("unknown type uses type as role", () => {
    const e = entry("keep_alive", "inbound");
    const c = compactifyEntry(e);
    expect(c.role).toBe("keep_alive");
  });

  test("tool field omitted when no tool_use block", () => {
    const e = entry("assistant", "inbound", {
      message: { content: [{ type: "text", text: "Just text" }] },
    });
    const c = compactifyEntry(e);
    expect(c.tool).toBeUndefined();
    expect("tool" in c).toBe(false);
  });

  test("content array with tool_result blocks", () => {
    const e = entry("user", "outbound", {
      message: {
        content: [{ type: "tool_result", content: "file contents here" }, { type: "tool_result" }],
      },
    });
    const c = compactifyEntry(e);
    expect(c.content).toBe("file contents here [tool_result]");
  });
});
