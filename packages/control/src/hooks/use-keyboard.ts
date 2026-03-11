import type { ServerStatus, SessionInfo } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useApp, useInput } from "ink";
import { useCallback, useState } from "react";
import type { AuthStatus } from "../components/auth-banner";
import type { TranscriptEntry } from "../components/claude-session-detail";
import { formatFullEntry, summarizeEntry } from "../components/claude-session-detail";
import { extractToolText } from "./ipc-tool-helpers";
import { type LogSource, buildLogSources } from "./use-logs";

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
  transcriptIndex: number;
  setTranscriptIndex: (fn: (i: number) => number) => void;
  transcriptEntries: TranscriptEntry[];
  expandedEntries: ReadonlySet<number>;
  setExpandedEntries: (fn: (prev: ReadonlySet<number>) => ReadonlySet<number>) => void;
}

interface UseKeyboardOptions {
  view: View;
  setView: (view: View) => void;
  serversNav: ServersNav;
  logsNav: LogsNav;
  claudeNav: ClaudeNav;
}

export function useKeyboard({ view, setView, serversNav, logsNav, claudeNav }: UseKeyboardOptions): void {
  const {
    servers,
    selectedIndex,
    setSelectedIndex,
    expandedServer,
    setExpandedServer,
    refresh,
    authStatus,
    setAuthStatus,
  } = serversNav;
  const {
    logSource,
    setLogSource,
    setLogScrollOffset,
    logLineCount,
    filterMode,
    setFilterMode,
    filterText,
    setFilterText,
  } = logsNav;
  const {
    sessions: claudeSessions,
    selectedIndex: claudeSelectedIndex,
    setSelectedIndex: setClaudeSelectedIndex,
    expandedSession,
    setExpandedSession,
    permissionIndex,
    setPermissionIndex,
    denyReasonMode,
    setDenyReasonMode,
    denyReasonText,
    setDenyReasonText,
    transcriptIndex,
    setTranscriptIndex,
    transcriptEntries,
    expandedEntries,
    setExpandedEntries,
  } = claudeNav;
  const { exit } = useApp();
  const [pagerBusy, setPagerBusy] = useState(false);

  const openPager = useCallback(
    async (sessionId: string) => {
      if (pagerBusy) return;
      setPagerBusy(true);
      try {
        const result = await ipcCall("callTool", {
          server: "_claude",
          tool: "claude_transcript",
          arguments: { sessionId, limit: 500 },
        });
        const text = extractToolText(result);
        if (!text) return;
        const entries = JSON.parse(text) as TranscriptEntry[];
        const formatted = entries
          .map((e) => {
            const dir = e.direction === "outbound" ? "→" : "←";
            const ts = new Date(e.timestamp).toISOString();
            const summary = summarizeEntry(e);
            const full = formatFullEntry(e);
            return `${ts} ${dir} ${summary}\n${full}`;
          })
          .join("\n\n---\n\n");

        const tmpFile = `/tmp/mcpctl-log-${sessionId.slice(0, 8)}.txt`;
        await Bun.write(tmpFile, formatted);

        const pager = process.env.PAGER || "less";
        // Temporarily exit raw mode for the pager
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdout.write("\x1b[?1049l"); // exit alt screen
        Bun.spawnSync([pager, tmpFile], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        process.stdout.write("\x1b[?1049h"); // re-enter alt screen
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
      } catch {
        // Pager errors are non-fatal
      } finally {
        setPagerBusy(false);
      }
    },
    [pagerBusy],
  );

  useInput((input, key) => {
    // -- Deny reason mode: capture text for denial message --
    if (denyReasonMode) {
      if (key.return) {
        const selectedSession = claudeSessions[claudeSelectedIndex];
        const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
        if (perm) {
          const args: Record<string, string> = {
            sessionId: selectedSession.sessionId,
            requestId: perm.requestId,
          };
          if (denyReasonText) args.message = denyReasonText;
          ipcCall("callTool", {
            server: "_claude",
            tool: "claude_deny",
            arguments: args,
          }).catch(() => {});
        }
        setDenyReasonText("");
        setDenyReasonMode(false);
        return;
      }
      if (key.escape) {
        setDenyReasonText("");
        setDenyReasonMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setDenyReasonText((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDenyReasonText((prev) => prev + input);
      }
      return;
    }

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

    // Esc: collapse expanded state first, then go back to servers
    if (key.escape && view !== "servers") {
      if (escAction(view, expandedSession) === "collapse-transcript") {
        setExpandedSession(null);
        return;
      }
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
      const selectedSession = claudeSessions[claudeSelectedIndex];

      // Ctrl+O: open full transcript in pager
      if (key.ctrl && input === "o") {
        if (selectedSession) {
          openPager(selectedSession.sessionId);
        }
        return;
      }

      // When transcript is expanded, j/k navigate within transcript entries
      if (expandedSession) {
        if (key.upArrow || input === "k") {
          setTranscriptIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow || input === "j") {
          setTranscriptIndex((i) => Math.min(Math.max(0, transcriptEntries.length - 1), i + 1));
          return;
        }

        // Enter: toggle expand/collapse selected entry
        if (key.return) {
          setExpandedEntries((prev) => {
            const next = new Set(prev);
            if (next.has(transcriptIndex)) {
              next.delete(transcriptIndex);
            } else {
              next.add(transcriptIndex);
            }
            return next;
          });
          return;
        }

        // Esc: collapse transcript (handled by escAction above)
      } else {
        // Navigate sessions (only when transcript not expanded)
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
          if (selectedSession) {
            setExpandedSession(selectedSession.sessionId);
          }
          return;
        }
      }

      // Navigate pending permissions within selected session
      if (key.leftArrow) {
        setPermissionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.rightArrow) {
        const permCount = selectedSession?.pendingPermissionDetails?.length ?? 0;
        setPermissionIndex((i) => Math.min(Math.max(0, permCount - 1), i + 1));
        return;
      }

      // Approve targeted pending permission
      if (input === "a") {
        const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
        if (perm) {
          ipcCall("callTool", {
            server: "_claude",
            tool: "claude_approve",
            arguments: { sessionId: selectedSession.sessionId, requestId: perm.requestId },
          }).catch(() => {});
        }
        return;
      }

      // Deny targeted pending permission — enter reason prompt
      if (input === "d") {
        const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
        if (perm) {
          setDenyReasonMode(true);
        }
        return;
      }

      // End session
      if (input === "x") {
        if (selectedSession) {
          ipcCall("callTool", {
            server: "_claude",
            tool: "claude_bye",
            arguments: { sessionId: selectedSession.sessionId },
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
