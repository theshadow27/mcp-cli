import { describe, expect, mock, test } from "bun:test";
import type { ServerStatus } from "@mcp-cli/core";
import type { Key } from "ink";
import type { LogsNav } from "./use-keyboard";
import { handleLogsInput } from "./use-keyboard-logs";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function makeNav(overrides: Partial<LogsNav> = {}): LogsNav {
  return {
    logSource: { type: "daemon" },
    setLogSource: mock(() => {}),
    logScrollOffset: 0,
    setLogScrollOffset: mock(() => {}),
    logLineCount: 100,
    filterMode: false,
    setFilterMode: mock(() => {}),
    filterText: "",
    setFilterText: mock(() => {}),
    ...overrides,
  };
}

const servers: ServerStatus[] = [{ name: "s1", state: "connected", transport: "stdio", toolCount: 0, source: "test" }];

describe("handleLogsInput", () => {
  test("j scrolls down", () => {
    const nav = makeNav();
    const consumed = handleLogsInput("j", baseKey, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setLogScrollOffset).toHaveBeenCalled();
  });

  test("k scrolls up", () => {
    const nav = makeNav();
    const consumed = handleLogsInput("k", baseKey, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setLogScrollOffset).toHaveBeenCalled();
  });

  test("f enters filter mode", () => {
    const nav = makeNav();
    const consumed = handleLogsInput("f", baseKey, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setFilterMode).toHaveBeenCalledWith(true);
  });

  test("/ enters filter mode", () => {
    const nav = makeNav();
    const consumed = handleLogsInput("/", baseKey, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setFilterMode).toHaveBeenCalledWith(true);
  });

  test("t cycles log source", () => {
    const nav = makeNav();
    const consumed = handleLogsInput("t", baseKey, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setLogSource).toHaveBeenCalled();
    expect(nav.setLogScrollOffset).toHaveBeenCalled();
  });

  test("t falls back to daemon source when current source no longer exists", () => {
    const nav = makeNav({ logSource: { type: "server", name: "gone-server" } });
    const consumed = handleLogsInput("t", baseKey, nav, servers);
    expect(consumed).toBe(true);
    // sources = [daemon, s1]; findIndex returns -1 for "gone-server"; nextIdx = 0 → daemon
    const setLogSourceCalls = (nav.setLogSource as ReturnType<typeof mock>).mock.calls;
    expect(setLogSourceCalls[0][0]).toEqual({ type: "daemon" });
  });

  test("unrecognized key returns false", () => {
    const nav = makeNav();
    expect(handleLogsInput("z", baseKey, nav, servers)).toBe(false);
  });
});

describe("handleLogsInput filter mode", () => {
  test("captures text input", () => {
    const nav = makeNav({ filterMode: true });
    const consumed = handleLogsInput("a", baseKey, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setFilterText).toHaveBeenCalled();
  });

  test("backspace deletes", () => {
    const nav = makeNav({ filterMode: true, filterText: "abc" });
    const consumed = handleLogsInput("", { ...baseKey, backspace: true }, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setFilterText).toHaveBeenCalled();
  });

  test("escape cancels filter", () => {
    const nav = makeNav({ filterMode: true, filterText: "test" });
    const consumed = handleLogsInput("", { ...baseKey, escape: true }, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setFilterText).toHaveBeenCalledWith("");
    expect(nav.setFilterMode).toHaveBeenCalledWith(false);
  });

  test("Enter confirms filter", () => {
    const nav = makeNav({ filterMode: true, filterText: "test" });
    const consumed = handleLogsInput("", { ...baseKey, return: true }, nav, servers);
    expect(consumed).toBe(true);
    expect(nav.setFilterMode).toHaveBeenCalledWith(false);
  });
});
