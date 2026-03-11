import { describe, expect, test } from "bun:test";
import {
  ALL_TABS,
  type ClaudeNav,
  type LogsNav,
  type ServersNav,
  escAction,
  nextTab,
  prevTab,
  tabByNumber,
} from "./use-keyboard";

describe("nextTab", () => {
  test("cycles forward through all tabs", () => {
    expect(nextTab("servers")).toBe("logs");
    expect(nextTab("logs")).toBe("claude");
    expect(nextTab("claude")).toBe("stats");
    expect(nextTab("stats")).toBe("mail");
    expect(nextTab("mail")).toBe("servers");
  });
});

describe("prevTab", () => {
  test("cycles backward through all tabs", () => {
    expect(prevTab("servers")).toBe("mail");
    expect(prevTab("logs")).toBe("servers");
    expect(prevTab("claude")).toBe("logs");
    expect(prevTab("stats")).toBe("claude");
    expect(prevTab("mail")).toBe("stats");
  });
});

describe("tabByNumber", () => {
  test("returns correct tab for 1-based index", () => {
    expect(tabByNumber(1)).toBe("servers");
    expect(tabByNumber(2)).toBe("logs");
    expect(tabByNumber(3)).toBe("claude");
    expect(tabByNumber(4)).toBe("stats");
    expect(tabByNumber(5)).toBe("mail");
  });

  test("returns undefined for out-of-range numbers", () => {
    expect(tabByNumber(0)).toBeUndefined();
    expect(tabByNumber(6)).toBeUndefined();
    expect(tabByNumber(-1)).toBeUndefined();
  });
});

describe("ALL_TABS", () => {
  test("contains exactly 5 tabs in expected order", () => {
    expect(ALL_TABS).toEqual(["servers", "logs", "claude", "stats", "mail"]);
  });
});

describe("escAction", () => {
  test("returns collapse-transcript when claude view has expanded session", () => {
    expect(escAction("claude", "session-1")).toBe("collapse-transcript");
  });

  test("returns navigate-servers when claude view has no expanded session", () => {
    expect(escAction("claude", null)).toBe("navigate-servers");
  });

  test("returns navigate-servers from logs view", () => {
    expect(escAction("logs", null)).toBe("navigate-servers");
  });

  test("returns navigate-servers from mail view", () => {
    expect(escAction("mail", null)).toBe("navigate-servers");
  });

  test("returns navigate-servers from stats view", () => {
    expect(escAction("stats", null)).toBe("navigate-servers");
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
      permissionIndex: 0,
      setPermissionIndex: () => {},
      denyReasonMode: false,
      setDenyReasonMode: () => {},
      denyReasonText: "",
      setDenyReasonText: () => {},
      transcriptCursor: null,
      setTranscriptCursor: () => {},
      transcriptEntries: [],
      expandedEntries: new Set<string>(),
      setExpandedEntries: () => {},
    };
    expect(nav.sessions).toBeArray();
    expect(nav.expandedSession).toBeNull();
    expect(nav.permissionIndex).toBe(0);
    expect(nav.denyReasonMode).toBe(false);
    expect(nav.denyReasonText).toBe("");
  });
});
