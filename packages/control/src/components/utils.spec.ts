import { describe, expect, it } from "bun:test";
import { PROTOCOL_VERSION } from "@mcp-cli/core";
import { extractToolText } from "../hooks/ipc-tool-helpers";
import { checkProtocolVersion } from "../hooks/protocol-check";
import { ALL_TABS, nextTab, prevTab, tabByNumber } from "../hooks/use-keyboard";
import { buildLogSources, filterLogLines } from "../hooks/use-logs";
import { isAuthError } from "./auth-banner";
import type { TranscriptEntry } from "./claude-session-detail";
import { summarizeEntry } from "./claude-session-detail";
import { formatCost, formatTokens, shortCwd, shortId } from "./claude-session-list";
import { formatUptime } from "./header";
import { formatRelativeTime } from "./server-detail";
import { buildBadges } from "./tab-bar";

describe("formatUptime", () => {
  it("formats seconds only", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(600)).toBe("10m 0s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatUptime(3661)).toBe("1h 1m 1s");
    expect(formatUptime(7200)).toBe("2h 0s");
  });

  it("omits zero hours and minutes", () => {
    expect(formatUptime(59)).toBe("59s");
    // hours > 0, minutes = 0 → still shows seconds
    expect(formatUptime(3600)).toBe("1h 0s");
  });
});

describe("isAuthError", () => {
  it("returns false for undefined/empty", () => {
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError("")).toBe(false);
  });

  it("detects HTTP 401", () => {
    expect(isAuthError("HTTP 401 Unauthorized")).toBe(true);
  });

  it("detects HTTP 403", () => {
    expect(isAuthError("HTTP 403 Forbidden")).toBe(true);
  });

  it("detects auth keyword", () => {
    expect(isAuthError("Authentication failed")).toBe(true);
    expect(isAuthError("authorization required")).toBe(true);
  });

  it("detects token keyword", () => {
    expect(isAuthError("Token expired")).toBe(true);
    expect(isAuthError("invalid token")).toBe(true);
  });

  it("detects oauth keyword", () => {
    expect(isAuthError("OAuth token rejected")).toBe(true);
  });

  it("detects unauthorized keyword", () => {
    expect(isAuthError("Unauthorized access")).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(isAuthError("Connection refused")).toBe(false);
    expect(isAuthError("ECONNRESET")).toBe(false);
    expect(isAuthError("Timeout after 5000ms")).toBe(false);
  });
});

describe("filterLogLines", () => {
  const lines = [
    { timestamp: 1000, line: "INFO: server started" },
    { timestamp: 2000, line: "WARN: slow query detected" },
    { timestamp: 3000, line: "ERROR: connection refused" },
    { timestamp: 4000, line: "INFO: request handled" },
    { timestamp: 5000, line: "DEBUG: cache miss" },
  ];

  it("returns all lines when filter is empty", () => {
    expect(filterLogLines(lines, "")).toEqual(lines);
    expect(filterLogLines(lines, "")).toBe(lines); // same reference
  });

  it("filters by case-insensitive substring", () => {
    const result = filterLogLines(lines, "error");
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("ERROR: connection refused");
  });

  it("matches partial strings", () => {
    const result = filterLogLines(lines, "info");
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.timestamp)).toEqual([1000, 4000]);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterLogLines(lines, "FATAL")).toEqual([]);
  });

  it("matches mixed case", () => {
    const result = filterLogLines(lines, "Cache");
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("DEBUG: cache miss");
  });
});

describe("buildLogSources", () => {
  it("returns daemon-only when no servers", () => {
    expect(buildLogSources([])).toEqual([{ type: "daemon" }]);
  });

  it("returns daemon + one entry per server", () => {
    const servers = [
      { name: "a", state: "connected" },
      { name: "b", state: "error" },
    ] as import("@mcp-cli/core").ServerStatus[];
    const result = buildLogSources(servers);
    expect(result).toEqual([{ type: "daemon" }, { type: "server", name: "a" }, { type: "server", name: "b" }]);
  });
});

describe("tab navigation", () => {
  it("ALL_TABS has 5 entries in correct order", () => {
    expect(ALL_TABS).toEqual(["servers", "logs", "claude", "stats", "mail"]);
  });

  it("nextTab cycles forward", () => {
    expect(nextTab("servers")).toBe("logs");
    expect(nextTab("logs")).toBe("claude");
    expect(nextTab("mail")).toBe("servers"); // wraps around
  });

  it("prevTab cycles backward", () => {
    expect(prevTab("servers")).toBe("mail"); // wraps around
    expect(prevTab("logs")).toBe("servers");
    expect(prevTab("claude")).toBe("logs");
  });

  it("tabByNumber maps 1-5 to tabs", () => {
    expect(tabByNumber(1)).toBe("servers");
    expect(tabByNumber(2)).toBe("logs");
    expect(tabByNumber(3)).toBe("claude");
    expect(tabByNumber(4)).toBe("stats");
    expect(tabByNumber(5)).toBe("mail");
  });

  it("tabByNumber returns undefined for out-of-range", () => {
    expect(tabByNumber(0)).toBeUndefined();
    expect(tabByNumber(6)).toBeUndefined();
  });
});

describe("buildBadges", () => {
  it("returns empty when all counts are zero", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 0 });
    expect(badges).toEqual({});
  });

  it("shows claude session count without color when no pending permissions", () => {
    const badges = buildBadges({ sessionCount: 3, pendingPermissionCount: 0, errorServerCount: 0 });
    expect(badges.claude).toEqual({ count: 3 });
    expect(badges.servers).toBeUndefined();
  });

  it("shows claude badge in red when pending permissions exist", () => {
    const badges = buildBadges({ sessionCount: 2, pendingPermissionCount: 1, errorServerCount: 0 });
    expect(badges.claude).toEqual({ count: 2, color: "red" });
  });

  it("shows servers badge in red when errors exist", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 2 });
    expect(badges.servers).toEqual({ count: 2, color: "red" });
    expect(badges.claude).toBeUndefined();
  });

  it("shows both badges when both have counts", () => {
    const badges = buildBadges({ sessionCount: 5, pendingPermissionCount: 3, errorServerCount: 1 });
    expect(badges.claude).toEqual({ count: 5, color: "red" });
    expect(badges.servers).toEqual({ count: 1, color: "red" });
  });
});

describe("formatRelativeTime", () => {
  it("formats seconds ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 30_000)).toBe("30s ago");
    expect(formatRelativeTime(now - 1_000)).toBe("1s ago");
  });

  it("formats minutes ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 120_000)).toBe("2m ago");
    expect(formatRelativeTime(now - 300_000)).toBe("5m ago");
  });

  it("formats hours ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 7_200_000)).toBe("2h ago");
  });

  it("formats days ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 172_800_000)).toBe("2d ago");
  });
});

describe("formatCost", () => {
  it("formats zero cost", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("formats fractional cost", () => {
    expect(formatCost(0.1234)).toBe("$0.1234");
    expect(formatCost(1.5)).toBe("$1.5000");
  });
});

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(15_500)).toBe("15.5k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("shortId", () => {
  it("returns first 8 characters", () => {
    expect(shortId("abcdefghijklmnop")).toBe("abcdefgh");
  });

  it("handles short strings", () => {
    expect(shortId("abc")).toBe("abc");
  });
});

describe("shortCwd", () => {
  it("returns empty string for null", () => {
    expect(shortCwd(null)).toBe("");
  });

  it("replaces HOME with ~", () => {
    const home = process.env.HOME ?? "";
    if (home) {
      expect(shortCwd(`${home}/projects/test`)).toBe("~/projects/test");
    }
  });

  it("truncates long paths", () => {
    expect(shortCwd("/very/long/path/that/exceeds/thirty/characters/easily").length).toBeLessThanOrEqual(30);
  });
});

describe("summarizeEntry", () => {
  it("summarizes assistant text message", () => {
    const entry: TranscriptEntry = {
      timestamp: 1000,
      direction: "outbound",
      message: {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    };
    expect(summarizeEntry(entry)).toBe("Hello world");
  });

  it("summarizes assistant tool use", () => {
    const entry: TranscriptEntry = {
      timestamp: 1000,
      direction: "outbound",
      message: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read" }],
        },
      },
    };
    expect(summarizeEntry(entry)).toBe("[tool: Read]");
  });

  it("summarizes result entries", () => {
    const entry: TranscriptEntry = {
      timestamp: 1000,
      direction: "inbound",
      message: { type: "result", result: "Done!" },
    };
    expect(summarizeEntry(entry)).toBe("Done!");
  });

  it("truncates long text", () => {
    const longText = "a".repeat(200);
    const entry: TranscriptEntry = {
      timestamp: 1000,
      direction: "outbound",
      message: {
        type: "assistant",
        message: { content: [{ type: "text", text: longText }] },
      },
    };
    const result = summarizeEntry(entry);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles unknown types", () => {
    const entry: TranscriptEntry = {
      timestamp: 1000,
      direction: "inbound",
      message: { type: "system" },
    };
    expect(summarizeEntry(entry)).toBe("[system]");
  });
});

describe("extractToolText", () => {
  it("extracts text from valid callTool result", () => {
    const result = { content: [{ type: "text", text: '{"key":"value"}' }] };
    expect(extractToolText(result)).toBe('{"key":"value"}');
  });

  it("returns null for empty content", () => {
    expect(extractToolText({ content: [] })).toBeNull();
  });

  it("returns null for undefined result", () => {
    expect(extractToolText(undefined)).toBeNull();
  });

  it("returns null for result without content", () => {
    expect(extractToolText({})).toBeNull();
  });
});

describe("checkProtocolVersion", () => {
  it("returns null when versions match", () => {
    expect(checkProtocolVersion(PROTOCOL_VERSION)).toBeNull();
  });

  it("returns null when daemon version is undefined", () => {
    expect(checkProtocolVersion(undefined)).toBeNull();
  });

  it("returns error message when versions differ", () => {
    const msg = checkProtocolVersion("old-hash-abc123");
    expect(msg).toContain("Protocol mismatch");
    expect(msg).toContain("old-hash-abc123");
    expect(msg).toContain(PROTOCOL_VERSION);
    expect(msg).toContain("mcx daemon restart");
  });
});
