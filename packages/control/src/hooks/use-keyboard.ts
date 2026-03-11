import type { ServerStatus, SessionInfo } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useApp, useInput } from "ink";
import type { AuthStatus } from "../components/auth-banner";
import { handleClaudeInput } from "./use-keyboard-claude";
import { handleLogsInput } from "./use-keyboard-logs";
import { handleServersInput } from "./use-keyboard-servers";
import type { LogSource } from "./use-logs";

export const ALL_TABS = ["servers", "logs", "claude", "stats", "mail"] as const;

export type View = (typeof ALL_TABS)[number];

export function nextTab(current: View): View {
  const idx = ALL_TABS.indexOf(current);
  return ALL_TABS[(idx + 1) % ALL_TABS.length];
}

export function prevTab(current: View): View {
  const idx = ALL_TABS.indexOf(current);
  return ALL_TABS[(idx - 1 + ALL_TABS.length) % ALL_TABS.length];
}

export function tabByNumber(n: number): View | undefined {
  return ALL_TABS[n - 1];
}

/** Determine what Esc should do from a non-servers view. Returns the action. */
export function escAction(view: View, expandedSession: string | null): "collapse-transcript" | "navigate-servers" {
  if (view === "claude" && expandedSession) return "collapse-transcript";
  return "navigate-servers";
}

export interface ServersNav {
  servers: ServerStatus[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedServer: string | null;
  setExpandedServer: (name: string | null) => void;
  refresh: () => void;
  authStatus: AuthStatus | null;
  setAuthStatus: (status: AuthStatus | null) => void;
}

export interface LogsNav {
  logSource: LogSource;
  setLogSource: (source: LogSource) => void;
  logScrollOffset: number;
  setLogScrollOffset: (fn: (offset: number) => number) => void;
  logLineCount: number;
  filterMode: boolean;
  setFilterMode: (mode: boolean) => void;
  filterText: string;
  setFilterText: (fn: string | ((prev: string) => string)) => void;
}

export interface ClaudeNav {
  sessions: SessionInfo[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedSession: string | null;
  setExpandedSession: (id: string | null) => void;
  permissionIndex: number;
  setPermissionIndex: (fn: (i: number) => number) => void;
  denyReasonMode: boolean;
  setDenyReasonMode: (mode: boolean) => void;
  denyReasonText: string;
  setDenyReasonText: (fn: string | ((prev: string) => string)) => void;
}

interface UseKeyboardOptions {
  view: View;
  setView: (view: View) => void;
  serversNav: ServersNav;
  logsNav: LogsNav;
  claudeNav: ClaudeNav;
}

export function useKeyboard({ view, setView, serversNav, logsNav, claudeNav }: UseKeyboardOptions): void {
  const { exit } = useApp();

  useInput((input, key) => {
    // Modal input modes are handled by their respective view handlers first,
    // before global keys, so they can capture all input.
    if (view === "claude" && claudeNav.denyReasonMode) {
      handleClaudeInput(input, key, claudeNav);
      return;
    }
    if (view === "logs" && logsNav.filterMode) {
      handleLogsInput(input, key, logsNav, serversNav.servers);
      return;
    }

    // Global: shutdown daemon
    if (input === "s") {
      ipcCall("shutdown").catch(() => {});
      exit();
      return;
    }

    // Global: quit
    if (input === "q") {
      exit();
      return;
    }

    // Global: Tab / Shift+Tab cycle tabs
    if (key.tab) {
      setView(key.shift ? prevTab(view) : nextTab(view));
      return;
    }

    // Global: number keys 1-5 jump to tab
    const tabNum = Number(input);
    if (tabNum >= 1 && tabNum <= ALL_TABS.length) {
      const target = tabByNumber(tabNum);
      if (target) setView(target);
      return;
    }

    // Global: `l` toggles to/from logs (backwards compat)
    if (input === "l") {
      if (view === "logs") {
        logsNav.setFilterText("");
        setView("servers");
      } else {
        setView("logs");
      }
      return;
    }

    // Esc: collapse expanded state first, then go back to servers
    if (key.escape && view !== "servers") {
      if (escAction(view, claudeNav.expandedSession) === "collapse-transcript") {
        claudeNav.setExpandedSession(null);
        return;
      }
      if (view === "logs") logsNav.setFilterText("");
      setView("servers");
      return;
    }

    // Delegate to active view handler
    if (view === "logs") {
      handleLogsInput(input, key, logsNav, serversNav.servers);
    } else if (view === "claude") {
      handleClaudeInput(input, key, claudeNav);
    } else if (view === "servers") {
      handleServersInput(input, key, serversNav);
    }
  });
}
