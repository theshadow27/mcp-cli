import { describe, expect, it } from "bun:test";
import type { DaemonStatus } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { Header, formatUptime } from "./header";

function daemonStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    pid: 1234,
    uptime: 100,
    servers: [],
    usageStats: [],
    ...overrides,
  } as DaemonStatus;
}

describe("formatUptime", () => {
  it("formats seconds only", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(125)).toBe("2m 5s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatUptime(3661)).toBe("1h 1m 1s");
  });

  it("floors fractional seconds from process.uptime()", () => {
    expect(formatUptime(251.0678)).toBe("4m 11s");
  });

  it("floors fractional seconds under a minute", () => {
    expect(formatUptime(11.9999)).toBe("11s");
  });

  it("handles zero", () => {
    expect(formatUptime(0)).toBe("0s");
  });
});

describe("Header", () => {
  it("does not show duplicate daemon warning when count is 0 or 1", () => {
    const { lastFrame } = render(
      React.createElement(Header, { status: daemonStatus(), error: null, daemonProcessCount: 1 }),
    );
    expect(lastFrame()).not.toContain("mcpd processes running");
  });

  it("does not show duplicate daemon warning when count is omitted", () => {
    const { lastFrame } = render(React.createElement(Header, { status: daemonStatus(), error: null }));
    expect(lastFrame()).not.toContain("mcpd processes running");
  });

  it("shows duplicate daemon warning when count > 1", () => {
    const { lastFrame } = render(
      React.createElement(Header, { status: daemonStatus(), error: null, daemonProcessCount: 4 }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("4 mcpd processes running");
    expect(frame).toContain("killall mcpd");
  });
});
