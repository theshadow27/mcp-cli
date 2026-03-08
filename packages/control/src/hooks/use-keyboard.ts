import type { ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useApp, useInput } from "ink";
import type { AuthStatus } from "../components/auth-banner";
import { type LogSource, buildLogSources } from "./use-logs";

export type View = "servers" | "logs";

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

    // -- Logs view --
    if (view === "logs") {
      // Back to servers
      if (input === "l" || key.escape) {
        setFilterText("");
        setView("servers");
        return;
      }

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

      // Cycle log source
      if (key.tab) {
        const sources = buildLogSources(servers);
        const currentIdx = sources.findIndex((s) => {
          if (s.type === "daemon" && logSource.type === "daemon") return true;
          if (s.type === "server" && logSource.type === "server" && s.name === logSource.name) return true;
          return false;
        });
        const nextIdx = (currentIdx + 1) % sources.length;
        setLogSource(sources[nextIdx]);
        setLogScrollOffset(() => 0);
        return;
      }

      return;
    }

    // -- Servers view --

    // Toggle to logs view
    if (input === "l") {
      setView("logs");
      return;
    }

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
