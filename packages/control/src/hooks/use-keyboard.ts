import type { ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useApp, useInput } from "ink";
import type { AuthStatus } from "../components/auth-banner";
import type { ClaudeSession } from "./use-claude-sessions";
import { type LogSource, buildLogSources } from "./use-logs";

export const ALL_TABS = ["servers", "logs", "claude", "mail", "stats"] as const;

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

interface UseKeyboardOptions {
  servers: ServerStatus[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedServer: string | null;
  setExpandedServer: (name: string | null) => void;
  refresh: () => void;
  authStatus: AuthStatus | null;
  setAuthStatus: (status: AuthStatus | null) => void;
  view: View;
  setView: (view: View) => void;
  logSource: LogSource;
  setLogSource: (source: LogSource) => void;
  logScrollOffset: number;
  setLogScrollOffset: (fn: (offset: number) => number) => void;
  logLineCount: number;
  filterMode: boolean;
  setFilterMode: (mode: boolean) => void;
  filterText: string;
  setFilterText: (fn: string | ((prev: string) => string)) => void;
  claudeSessions: ClaudeSession[];
  claudeSelectedIndex: number;
  setClaudeSelectedIndex: (fn: (i: number) => number) => void;
  expandedSession: string | null;
  setExpandedSession: (id: string | null) => void;
}

export function useKeyboard({
  servers,
  selectedIndex,
  setSelectedIndex,
  expandedServer,
  setExpandedServer,
  refresh,
  authStatus,
  setAuthStatus,
  view,
  setView,
  logSource,
  setLogSource,
  logScrollOffset,
  setLogScrollOffset,
  logLineCount,
  filterMode,
  setFilterMode,
  filterText,
  setFilterText,
  claudeSessions,
  claudeSelectedIndex,
  setClaudeSelectedIndex,
  expandedSession,
  setExpandedSession,
}: UseKeyboardOptions): void {
  const { exit } = useApp();

  useInput((input, key) => {
    // -- Filter mode: capture all input for filter text --
    if (filterMode) {
      if (key.return) {
        setFilterMode(false);
        return;
      }
      if (key.escape) {
        setFilterText("");
        setFilterMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilterText((prev) => prev.slice(0, -1));
        return;
      }
      // Append printable characters
      if (input && !key.ctrl && !key.meta) {
        setFilterText((prev) => prev + input);
      }
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
        setFilterText("");
        setView("servers");
      } else {
        setView("logs");
      }
      return;
    }

    // Esc: go back to servers from any non-servers tab
    if (key.escape && view !== "servers") {
      if (view === "logs") setFilterText("");
      setView("servers");
      return;
    }

    // -- Logs view --
    if (view === "logs") {
      // Enter filter mode
      if (input === "f" || input === "/") {
        setFilterMode(true);
        return;
      }

      // Scroll up
      if (key.upArrow || input === "k") {
        setLogScrollOffset((o) => Math.max(0, o - 1));
        return;
      }

      // Scroll down
      if (key.downArrow || input === "j") {
        setLogScrollOffset((o) => Math.min(Math.max(0, logLineCount - 1), o + 1));
        return;
      }

      // Cycle log source (t key, since Tab now cycles tabs)
      if (input === "t") {
        const sources = buildLogSources(servers);
        const currentIdx = sources.findIndex((src) => {
          if (src.type === "daemon" && logSource.type === "daemon") return true;
          if (src.type === "server" && logSource.type === "server" && src.name === logSource.name) return true;
          return false;
        });
        const nextIdx = (currentIdx + 1) % sources.length;
        setLogSource(sources[nextIdx]);
        setLogScrollOffset(() => 0);
        return;
      }

      return;
    }

    // -- Claude view --
    if (view === "claude") {
      // Navigate sessions
      if (key.upArrow || input === "k") {
        setClaudeSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setClaudeSelectedIndex((i) => Math.min(claudeSessions.length - 1, i + 1));
        return;
      }

      // Toggle transcript detail
      if (key.return) {
        const session = claudeSessions[claudeSelectedIndex];
        if (session) {
          setExpandedSession(expandedSession === session.sessionId ? null : session.sessionId);
        }
        return;
      }

      // End session
      if (input === "x") {
        const session = claudeSessions[claudeSelectedIndex];
        if (session) {
          ipcCall("callTool", {
            server: "_claude",
            tool: "claude_bye",
            arguments: { sessionId: session.sessionId },
          }).catch(() => {});
          setExpandedSession(null);
        }
        return;
      }

      return;
    }

    // -- Servers view --
    if (view !== "servers") return;

    // Navigation
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(servers.length - 1, i + 1));
      return;
    }

    // Toggle detail view
    if (key.return) {
      const server = servers[selectedIndex];
      if (server) {
        setExpandedServer(expandedServer === server.name ? null : server.name);
      }
      return;
    }

    // Trigger auth for selected server
    if (input === "a") {
      if (authStatus?.state === "pending") return;
      const server = servers[selectedIndex];
      if (!server) return;
      setAuthStatus({ server: server.name, state: "pending" });
      ipcCall("triggerAuth", { server: server.name })
        .then(() => {
          setAuthStatus({ server: server.name, state: "success" });
          refresh();
        })
        .catch((err) => {
          setAuthStatus({
            server: server.name,
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      return;
    }

    // Restart selected server
    if (input === "r") {
      const server = servers[selectedIndex];
      if (server) {
        ipcCall("restartServer", { server: server.name })
          .then(refresh)
          .catch(() => {});
      }
      return;
    }

    // Restart all servers
    if (input === "R") {
      ipcCall("restartServer", {})
        .then(refresh)
        .catch(() => {});
      return;
    }
  });
}
