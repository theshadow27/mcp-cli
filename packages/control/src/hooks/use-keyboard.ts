import type { AgentSessionInfo, ServerStatus } from "@mcp-cli/core";
import { ipcCall, options } from "@mcp-cli/core";
import { useApp, useInput } from "ink";
import { useCallback, useRef } from "react";
import type { TranscriptEntry } from "../components/agent-session-detail";
import { entryKey, formatFullEntry, summarizeEntry } from "../components/agent-session-detail";
import type { AuthStatus } from "../components/auth-banner";
import { extractToolText, serverForProvider, toolForProvider } from "./ipc-tool-helpers";
import { handleClaudeInput } from "./use-keyboard-claude";
import { handleLogsInput } from "./use-keyboard-logs";
import type { MailNav } from "./use-keyboard-mail";
import { handleMailInput } from "./use-keyboard-mail";
import type { PlansNav } from "./use-keyboard-plans";
import { clearPlansState, handlePlansInput } from "./use-keyboard-plans";
import { handleServersInput } from "./use-keyboard-servers";
import { handleStatsInput } from "./use-keyboard-stats";
import type { LogSource } from "./use-logs";

export const ALL_TABS = ["servers", "logs", "agents", "stats", "plans", "mail"] as const;

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
  if (view === "agents" && expandedSession) return "collapse-transcript";
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
  addServerMode: boolean;
  setAddServerMode: (mode: boolean) => void;
  addServerState: import("../components/server-add-form").AddServerState;
  setAddServerState: (
    fn:
      | import("../components/server-add-form").AddServerState
      | ((
          prev: import("../components/server-add-form").AddServerState,
        ) => import("../components/server-add-form").AddServerState),
  ) => void;
  confirmRemove: boolean;
  setConfirmRemove: (mode: boolean) => void;
  configInfo: Record<string, { source: string; scope: string }>;
  /** Injected for testing — defaults to the real addServerToConfig. */
  onAddServer?: (scope: "user" | "project", name: string, config: import("@mcp-cli/core").ServerConfig) => void;
  /** Injected for testing — defaults to the real removeServerFromConfig. */
  onRemoveServer?: (scope: "user" | "project", name: string) => void;
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
  sessions: AgentSessionInfo[];
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
  transcriptCursor: string | null;
  setTranscriptCursor: (fn: (prev: string | null) => string | null) => void;
  transcriptEntries: TranscriptEntry[];
  expandedEntries: ReadonlySet<string>;
  setExpandedEntries: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  transcriptScrollOffset: number;
  setTranscriptScrollOffset: (fn: (offset: number) => number) => void;
  transcriptViewHeight: number;
  promptMode: boolean;
  setPromptMode: (mode: boolean) => void;
  promptText: string;
  setPromptText: (fn: string | ((prev: string) => string)) => void;
}

export interface StatsNav {
  scrollOffset: number;
  setScrollOffset: (fn: (offset: number) => number) => void;
  lineCount: number;
}

export type { MailNav } from "./use-keyboard-mail";
export type { PlansNav } from "./use-keyboard-plans";

interface UseKeyboardOptions {
  view: View;
  setView: (view: View) => void;
  serversNav: ServersNav;
  logsNav: LogsNav;
  claudeNav: ClaudeNav;
  statsNav: StatsNav;
  plansNav: PlansNav;
  mailNav: MailNav;
}

export function useKeyboard({
  view,
  setView,
  serversNav,
  logsNav,
  claudeNav,
  statsNav,
  plansNav,
  mailNav,
}: UseKeyboardOptions): void {
  const { exit } = useApp();
  const pagerBusyRef = useRef(false);

  const openPager = useCallback(async (session: AgentSessionInfo) => {
    if (pagerBusyRef.current) return;
    pagerBusyRef.current = true;
    const { join } = await import("node:path");
    const { unlinkSync } = await import("node:fs");
    const tmpFile = join(options.MCP_CLI_DIR, `mcpctl-log-${session.sessionId}.txt`);
    try {
      const result = await ipcCall("callTool", {
        server: serverForProvider(session.provider),
        tool: toolForProvider(session.provider, "transcript"),
        arguments: { sessionId: session.sessionId, limit: 500 },
      });
      const text = extractToolText(result);
      if (!text) {
        console.error("[mcpctl] Empty transcript for session", session.sessionId);
        return;
      }
      const entries = JSON.parse(text) as TranscriptEntry[];
      if (entries.length === 0) {
        console.error("[mcpctl] No transcript entries for session", session.sessionId);
        return;
      }
      const formatted = entries
        .map((e) => {
          const dir = e.direction === "outbound" ? "\u2192" : "\u2190";
          const ts = new Date(e.timestamp).toISOString();
          const summary = summarizeEntry(e);
          const full = formatFullEntry(e);
          return `${ts} ${dir} ${summary}\n${full}`;
        })
        .join("\n\n---\n\n");

      await Bun.write(tmpFile, formatted);

      const pagerEnv = process.env.PAGER || "less";
      const pagerArgs = pagerEnv.split(/\s+/).filter(Boolean);
      // Temporarily exit raw mode for the pager
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdout.write("\x1b[?1049l"); // exit alt screen
      try {
        Bun.spawnSync([...pagerArgs, tmpFile], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      } finally {
        process.stdout.write("\x1b[?1049h"); // re-enter alt screen
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
      }
    } catch (err) {
      console.error("[mcpctl] Pager error:", err instanceof Error ? err.message : String(err));
    } finally {
      pagerBusyRef.current = false;
      try {
        unlinkSync(tmpFile);
      } catch {
        /* file may not have been written */
      }
    }
  }, []);

  useInput((input, key) => {
    // Modal input modes are handled by their respective view handlers first,
    // before global keys, so they can capture all input.
    if (view === "servers" && (serversNav.addServerMode || serversNav.confirmRemove)) {
      handleServersInput(input, key, serversNav);
      return;
    }
    if (view === "agents" && (claudeNav.denyReasonMode || claudeNav.promptMode)) {
      handleClaudeInput(input, key, claudeNav);
      return;
    }
    if (view === "logs" && logsNav.filterMode) {
      handleLogsInput(input, key, logsNav, serversNav.servers);
      return;
    }
    if (view === "plans" && plansNav.confirmAbort && input !== "q" && input !== "s") {
      handlePlansInput(input, key, plansNav);
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

    // Helper: clear plans modal state when navigating away
    const leavePlansView = () => {
      if (view === "plans") clearPlansState(plansNav);
    };

    // Global: Tab / Shift+Tab cycle tabs
    if (key.tab) {
      leavePlansView();
      setView(key.shift ? prevTab(view) : nextTab(view));
      return;
    }

    // Global: number keys jump to tab
    const tabNum = Number(input);
    if (tabNum >= 1 && tabNum <= ALL_TABS.length) {
      const target = tabByNumber(tabNum);
      if (target) {
        leavePlansView();
        setView(target);
      }
      return;
    }

    // Global: `l` toggles to/from logs (backwards compat)
    if (input === "l") {
      if (view === "logs") {
        logsNav.setFilterText("");
        setView("servers");
      } else {
        leavePlansView();
        setView("logs");
      }
      return;
    }

    // Esc: collapse expanded state first, then go back to servers
    if (key.escape && view !== "servers") {
      if (escAction(view, claudeNav.expandedSession) === "collapse-transcript") {
        claudeNav.setExpandedSession(null);
        claudeNav.setTranscriptCursor(() => null);
        claudeNav.setTranscriptScrollOffset(() => 0);
        claudeNav.setExpandedEntries(() => new Set());
        return;
      }
      if (view === "mail" && mailNav.expandedMessage !== null) {
        mailNav.setExpandedMessage(null);
        mailNav.setScrollOffset(() => 0);
        return;
      }
      if (view === "plans" && plansNav.expandedPlan !== null) {
        plansNav.setExpandedPlan(null);
        plansNav.setSelectedStep(() => 0);
        return;
      }
      if (view === "logs") logsNav.setFilterText("");
      leavePlansView();
      setView("servers");
      return;
    }

    // Agents: Ctrl+O opens full transcript in pager (handled here because openPager is a hook callback)
    if (view === "agents" && key.ctrl && input === "o") {
      const selectedSession = claudeNav.sessions[claudeNav.selectedIndex];
      if (selectedSession) {
        openPager(selectedSession);
      }
      return;
    }

    // Delegate to active view handler
    if (view === "logs") {
      handleLogsInput(input, key, logsNav, serversNav.servers);
    } else if (view === "agents") {
      handleClaudeInput(input, key, claudeNav);
    } else if (view === "stats") {
      handleStatsInput(input, key, statsNav);
    } else if (view === "plans") {
      handlePlansInput(input, key, plansNav);
    } else if (view === "mail") {
      handleMailInput(input, key, mailNav);
    } else if (view === "servers") {
      handleServersInput(input, key, serversNav);
    }
  });
}
