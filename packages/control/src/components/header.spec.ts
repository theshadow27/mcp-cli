import { describe, expect, it } from "bun:test";
import { formatUptime } from "./header";

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
