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

describe("Header", () => {
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

describe("formatUptime", () => {
  it("formats seconds only", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(125)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3665)).toBe("1h 1m 5s");
  });
});
