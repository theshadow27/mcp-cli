import { describe, expect, test } from "bun:test";
import {
  type TranscriptEntry,
  compactTranscript,
  estimateCost,
  filterByRepo,
  formatAge,
  formatCost,
  formatSessionShort,
} from "./session-display";

describe("estimateCost", () => {
  test("returns null for zero tokens", () => {
    expect(estimateCost(0)).toBeNull();
  });

  test("returns null for undefined/null", () => {
    expect(estimateCost(undefined)).toBeNull();
    expect(estimateCost(null)).toBeNull();
  });

  test("estimates cost at $5/M tokens", () => {
    const cost = estimateCost(1_000_000);
    expect(cost).toBeCloseTo(5.0, 4);
  });

  test("estimates small token counts", () => {
    const cost = estimateCost(1000);
    expect(cost).toBeCloseTo(0.005, 6);
  });
});

describe("formatCost", () => {
  test("uses real cost when available", () => {
    expect(formatCost(1.2345, 1000)).toBe("$1.2345");
  });

  test("uses estimated cost when real cost is null", () => {
    expect(formatCost(null, 1000)).toBe("~$0.0050");
  });

  test("uses estimated cost when real cost is zero", () => {
    expect(formatCost(0, 1000)).toBe("~$0.0050");
  });

  test("returns dash when no cost or tokens", () => {
    expect(formatCost(null, null)).toBe("—");
    expect(formatCost(null, 0)).toBe("—");
  });
});

describe("filterByRepo", () => {
  const sessions = [
    { sessionId: "a", cwd: "/repo/project/src" },
    { sessionId: "b", cwd: "/other/place" },
    { sessionId: "c", cwd: "/repo/project/tests" },
    { sessionId: "d", cwd: null },
  ];

  test("filters sessions by repo root prefix", () => {
    const filtered = filterByRepo(sessions, "/repo/project");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.sessionId)).toEqual(["a", "c"]);
  });

  test("excludes sessions with null cwd", () => {
    const filtered = filterByRepo(sessions, "/repo/project");
    expect(filtered.every((s) => s.cwd !== null)).toBe(true);
  });

  test("returns empty when no matches", () => {
    const filtered = filterByRepo(sessions, "/nonexistent");
    expect(filtered).toHaveLength(0);
  });
});

describe("compactTranscript", () => {
  test("truncates long tool results", () => {
    const longResult = "x".repeat(200);
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "result", result: longResult },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    const result = (compacted[0].message as Record<string, unknown>).result as string;
    expect(result.length).toBe(101); // 100 chars + "…"
    expect(result.endsWith("…")).toBe(true);
  });

  test("leaves short results unchanged", () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "result", result: "short" },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    expect((compacted[0].message as Record<string, unknown>).result).toBe("short");
  });

  test("truncates tool_result content in assistant messages", () => {
    const longContent = "y".repeat(200);
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: {
          type: "assistant",
          message: {
            content: [{ type: "tool_result", content: longContent }],
          },
        },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    const msg = compacted[0].message.message as { content: Array<{ content: string }> };
    expect(msg.content[0].content.length).toBe(101);
    expect(msg.content[0].content.endsWith("…")).toBe(true);
  });

  test("preserves non-tool entries unchanged", () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: { type: "user", message: { content: "hello" } },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    expect(compacted).toEqual(entries);
  });
});

describe("formatAge", () => {
  const NOW = Date.UTC(2026, 2, 23, 12, 0, 0); // 2026-03-23 12:00 UTC

  test("returns empty string for null/undefined", () => {
    expect(formatAge(null, NOW)).toBe("");
    expect(formatAge(undefined, NOW)).toBe("");
  });

  test("returns empty string for sessions < 24h old", () => {
    const recent = NOW - 23 * 60 * 60 * 1000; // 23 hours ago
    expect(formatAge(recent, NOW)).toBe("");
  });

  test("returns date label for sessions >= 24h old", () => {
    const old = Date.UTC(2026, 2, 19, 10, 0, 0); // Mar 19
    expect(formatAge(old, NOW)).toBe("(Mar 19)");
  });

  test("returns date label for sessions days old", () => {
    const old = Date.UTC(2026, 0, 15, 8, 0, 0); // Jan 15
    expect(formatAge(old, NOW)).toBe("(Jan 15)");
  });
});

describe("formatSessionShort with createdAt", () => {
  test("appends age for old sessions", () => {
    const old = Date.UTC(2026, 2, 19, 10, 0, 0);
    const line = formatSessionShort({
      sessionId: "e94a6668-1234-5678-9abc-def012345678",
      state: "active",
      model: "claude-opus-4-6[1m]",
      cost: 519.51,
      tokens: 4912380,
      numTurns: 8415,
      createdAt: old,
    });
    expect(line).toContain("(Mar 19)");
    expect(line).toStartWith("e94a6668");
  });

  test("no age suffix for recent sessions", () => {
    const line = formatSessionShort({
      sessionId: "84418297-1234-5678-9abc-def012345678",
      state: "active",
      model: "claude-opus-4-6[1m]",
      cost: 1.01,
      tokens: 6885,
      numTurns: 27,
      createdAt: Date.now(),
    });
    expect(line).not.toContain("(");
  });

  test("no age suffix when createdAt is null", () => {
    const line = formatSessionShort({
      sessionId: "84418297-1234-5678-9abc-def012345678",
      state: "active",
      createdAt: null,
    });
    expect(line).not.toContain("(");
  });
});
