import { describe, expect, it } from "bun:test";
import { escAction, nextTab, prevTab, tabByNumber } from "./use-keyboard";

describe("tab navigation helpers", () => {
  it("nextTab cycles forward", () => {
    expect(nextTab("servers")).toBe("logs");
    expect(nextTab("stats")).toBe("servers");
  });

  it("prevTab cycles backward", () => {
    expect(prevTab("servers")).toBe("stats");
    expect(prevTab("logs")).toBe("servers");
  });

  it("tabByNumber maps 1-indexed to tab", () => {
    expect(tabByNumber(1)).toBe("servers");
    expect(tabByNumber(3)).toBe("claude");
    expect(tabByNumber(0)).toBeUndefined();
    expect(tabByNumber(99)).toBeUndefined();
  });
});

describe("escAction", () => {
  it("returns collapse-transcript when claude view has expanded session", () => {
    expect(escAction("claude", "session-1")).toBe("collapse-transcript");
  });

  it("returns navigate-servers when claude view has no expanded session", () => {
    expect(escAction("claude", null)).toBe("navigate-servers");
  });

  it("returns navigate-servers from logs view", () => {
    expect(escAction("logs", null)).toBe("navigate-servers");
  });

  it("returns navigate-servers from mail view", () => {
    expect(escAction("mail", null)).toBe("navigate-servers");
  });

  it("returns navigate-servers from stats view", () => {
    expect(escAction("stats", null)).toBe("navigate-servers");
  });
});
