import { describe, expect, test } from "bun:test";
import {
  ALL_TABS,
  type ClaudeNav,
  type LogsNav,
  type ServersNav,
  type StatsNav,
  escAction,
  nextTab,
  prevTab,
  tabByNumber,
} from "./use-keyboard";

describe("nextTab", () => {
  test("cycles forward through all tabs", () => {
    expect(nextTab("servers")).toBe("logs");
    expect(nextTab("logs")).toBe("agents");
    expect(nextTab("agents")).toBe("stats");
    expect(nextTab("stats")).toBe("plans");
    expect(nextTab("plans")).toBe("mail");
    expect(nextTab("mail")).toBe("registry");
    expect(nextTab("registry")).toBe("servers");
  });
});

describe("prevTab", () => {
  test("cycles backward through all tabs", () => {
    expect(prevTab("servers")).toBe("registry");
    expect(prevTab("logs")).toBe("servers");
    expect(prevTab("agents")).toBe("logs");
    expect(prevTab("stats")).toBe("agents");
    expect(prevTab("plans")).toBe("stats");
    expect(prevTab("mail")).toBe("plans");
    expect(prevTab("registry")).toBe("mail");
  });
});

describe("tabByNumber", () => {
  test("returns correct tab for 1-based index", () => {
    expect(tabByNumber(1)).toBe("servers");
    expect(tabByNumber(2)).toBe("logs");
    expect(tabByNumber(3)).toBe("agents");
    expect(tabByNumber(4)).toBe("stats");
    expect(tabByNumber(5)).toBe("plans");
    expect(tabByNumber(6)).toBe("mail");
  });

  test("returns undefined for out-of-range numbers", () => {
    expect(tabByNumber(0)).toBeUndefined();
    expect(tabByNumber(8)).toBeUndefined();
    expect(tabByNumber(-1)).toBeUndefined();
  });
});

describe("ALL_TABS", () => {
  test("contains exactly 7 tabs in expected order", () => {
    expect(ALL_TABS).toEqual(["servers", "logs", "agents", "stats", "plans", "mail", "registry"]);
  });
});

describe("escAction", () => {
  test("returns collapse-transcript when agents view has expanded session", () => {
    expect(escAction("agents", "session-1")).toBe("collapse-transcript");
  });

  test("returns navigate-servers when agents view has no expanded session", () => {
    expect(escAction("agents", null)).toBe("navigate-servers");
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
      addServerMode: false,
      setAddServerMode: () => {},
      addServerState: {
        step: "transport",
        transport: "http",
        name: "",
        url: "",
        env: [],
        envInput: "",
        envError: "",
        scope: "user",
      },
      setAddServerState: () => {},
      confirmRemove: false,
      setConfirmRemove: () => {},
      configInfo: {},
      serveInstances: [],
      confirmKillServe: false,
      setConfirmKillServe: () => {},
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

  test("StatsNav shape is structurally valid", () => {
    const nav: StatsNav = {
      scrollOffset: 0,
      setScrollOffset: () => {},
      lineCount: 0,
    };
    expect(nav.scrollOffset).toBe(0);
    expect(nav.lineCount).toBe(0);
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
      transcriptScrollOffset: 0,
      setTranscriptScrollOffset: () => 0,
      transcriptViewHeight: 15,
      promptMode: false,
      setPromptMode: () => {},
      promptText: "",
      setPromptText: () => {},
    };
    expect(nav.sessions).toBeArray();
    expect(nav.expandedSession).toBeNull();
    expect(nav.permissionIndex).toBe(0);
    expect(nav.denyReasonMode).toBe(false);
    expect(nav.denyReasonText).toBe("");
  });
});
