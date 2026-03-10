import { describe, expect, test } from "bun:test";
import { ALL_TABS, type ClaudeNav, type LogsNav, type ServersNav, nextTab, prevTab, tabByNumber } from "./use-keyboard";

describe("nextTab", () => {
  test("cycles forward through all tabs", () => {
    expect(nextTab("servers")).toBe("logs");
    expect(nextTab("logs")).toBe("claude");
    expect(nextTab("claude")).toBe("mail");
    expect(nextTab("mail")).toBe("stats");
    expect(nextTab("stats")).toBe("servers");
  });
});

describe("prevTab", () => {
  test("cycles backward through all tabs", () => {
    expect(prevTab("servers")).toBe("stats");
    expect(prevTab("logs")).toBe("servers");
    expect(prevTab("claude")).toBe("logs");
    expect(prevTab("mail")).toBe("claude");
    expect(prevTab("stats")).toBe("mail");
  });
});

describe("tabByNumber", () => {
  test("returns correct tab for 1-based index", () => {
    expect(tabByNumber(1)).toBe("servers");
    expect(tabByNumber(2)).toBe("logs");
    expect(tabByNumber(3)).toBe("claude");
    expect(tabByNumber(4)).toBe("mail");
    expect(tabByNumber(5)).toBe("stats");
  });

  test("returns undefined for out-of-range numbers", () => {
    expect(tabByNumber(0)).toBeUndefined();
    expect(tabByNumber(6)).toBeUndefined();
    expect(tabByNumber(-1)).toBeUndefined();
  });
});

describe("ALL_TABS", () => {
  test("contains exactly 5 tabs in expected order", () => {
    expect(ALL_TABS).toEqual(["servers", "logs", "claude", "mail", "stats"]);
  });
});

describe("exported nav interfaces", () => {
  test("ServersNav shape is structurally valid", () => {
    const nav: ServersNav = {
      servers: [],
      selectedIndex: 0,
      setSelectedIndex: () => {},
      expandedServer: null,
      setExpandedServer: () => {},
      refresh: () => {},
      authStatus: null,
      setAuthStatus: () => {},
    };
    expect(nav.servers).toBeArray();
    expect(nav.selectedIndex).toBe(0);
    expect(nav.expandedServer).toBeNull();
    expect(nav.authStatus).toBeNull();
  });

  test("LogsNav shape is structurally valid", () => {
    const nav: LogsNav = {
      logSource: { type: "daemon" },
      setLogSource: () => {},
      logScrollOffset: 0,
      setLogScrollOffset: () => {},
      logLineCount: 0,
      filterMode: false,
      setFilterMode: () => {},
      filterText: "",
      setFilterText: () => {},
    };
    expect(nav.logSource.type).toBe("daemon");
    expect(nav.filterMode).toBe(false);
    expect(nav.filterText).toBe("");
  });

  test("ClaudeNav shape is structurally valid", () => {
    const nav: ClaudeNav = {
      sessions: [],
      selectedIndex: 0,
      setSelectedIndex: () => {},
      expandedSession: null,
      setExpandedSession: () => {},
    };
    expect(nav.sessions).toBeArray();
    expect(nav.expandedSession).toBeNull();
  });
});
