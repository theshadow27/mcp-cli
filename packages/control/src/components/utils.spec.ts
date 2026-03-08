import { describe, expect, it } from "bun:test";
import { ALL_TABS, nextTab, prevTab, tabByNumber } from "../hooks/use-keyboard";
import { buildLogSources, filterLogLines } from "../hooks/use-logs";
import { isAuthError } from "./auth-banner";
import { formatUptime } from "./header";
import { formatRelativeTime } from "./server-detail";

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
    expect(ALL_TABS).toEqual(["servers", "logs", "claude", "mail", "stats"]);
  });

  it("nextTab cycles forward", () => {
    expect(nextTab("servers")).toBe("logs");
    expect(nextTab("logs")).toBe("claude");
    expect(nextTab("stats")).toBe("servers"); // wraps around
  });

  it("prevTab cycles backward", () => {
    expect(prevTab("servers")).toBe("stats"); // wraps around
    expect(prevTab("logs")).toBe("servers");
    expect(prevTab("claude")).toBe("logs");
  });

  it("tabByNumber maps 1-5 to tabs", () => {
    expect(tabByNumber(1)).toBe("servers");
    expect(tabByNumber(2)).toBe("logs");
    expect(tabByNumber(3)).toBe("claude");
    expect(tabByNumber(4)).toBe("mail");
    expect(tabByNumber(5)).toBe("stats");
  });

  it("tabByNumber returns undefined for out-of-range", () => {
    expect(tabByNumber(0)).toBeUndefined();
    expect(tabByNumber(6)).toBeUndefined();
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
