import { describe, expect, it } from "bun:test";
import type { DaemonStatus } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { Header, formatUptime } from "./header";

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    pid: 1234,
    uptime: 100,
    protocolVersion: "1",
    servers: [],
    dbPath: "/tmp/test.db",
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
    const { lastFrame } = render(<Header status={status()} error={null} daemonProcessCount={1} />);
    expect(lastFrame()).not.toContain("mcpd processes running");
  });

  it("does not show duplicate daemon warning when count is omitted", () => {
    const { lastFrame } = render(<Header status={status()} error={null} />);
    expect(lastFrame()).not.toContain("mcpd processes running");
  });

  it("shows duplicate daemon warning when count > 1", () => {
    const { lastFrame } = render(<Header status={status()} error={null} daemonProcessCount={4} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("4 mcpd processes running");
    expect(frame).toContain("killall mcpd");
  });

  it("shows WS port warning when port differs from expected", () => {
    const { lastFrame } = render(<Header status={status({ wsPort: 54321, wsPortExpected: 19275 })} error={null} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("WS on port 54321");
    expect(frame).toContain("expected 19275");
    expect(frame).toContain("may not reconnect");
  });

  it("does not show WS port warning when port matches expected", () => {
    const { lastFrame } = render(<Header status={status({ wsPort: 19275, wsPortExpected: 19275 })} error={null} />);
    expect(lastFrame() ?? "").not.toContain("WS on port");
  });

  it("does not show WS port warning when wsPort is null", () => {
    const { lastFrame } = render(<Header status={status({ wsPort: null, wsPortExpected: 19275 })} error={null} />);
    expect(lastFrame() ?? "").not.toContain("WS on port");
  });

  it("does not show WS port warning when fields are absent", () => {
    const { lastFrame } = render(<Header status={status()} error={null} />);
    expect(lastFrame() ?? "").not.toContain("WS on port");
  });

  it("shows port holder when wsPortHolder is provided", () => {
    const { lastFrame } = render(
      <Header
        status={status({ wsPort: 54321, wsPortExpected: 19275, wsPortHolder: "mcpd (PID 38291)" })}
        error={null}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Port 19275 held by: mcpd (PID 38291)");
  });

  it("does not show port holder line when wsPortHolder is null", () => {
    const { lastFrame } = render(
      <Header status={status({ wsPort: 54321, wsPortExpected: 19275, wsPortHolder: null })} error={null} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("WS on port 54321");
    expect(frame).not.toContain("held by");
  });
});
