import { describe, expect, it } from "bun:test";
import { isAuthError } from "./auth-banner.js";
import { formatUptime } from "./header.js";
import { formatRelativeTime } from "./server-detail.js";

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
