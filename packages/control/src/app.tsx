import { Box, Text } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AuthBanner, type AuthStatus, isAuthError } from "./components/auth-banner.js";
import { ClaudeSessionList } from "./components/claude-session-list.js";
import { Footer } from "./components/footer.js";
import { Header } from "./components/header.js";
import { Loading } from "./components/loading.js";
import { LogViewer } from "./components/log-viewer.js";
import { ServerList } from "./components/server-list.js";
import { TabBar, buildBadges } from "./components/tab-bar.js";
import { useClaudeSessions } from "./hooks/use-claude-sessions.js";
import { useDaemon } from "./hooks/use-daemon.js";
import type { View } from "./hooks/use-keyboard.js";
import { useKeyboard } from "./hooks/use-keyboard.js";
import { filterLogLines, useLogs } from "./hooks/use-logs.js";

const LOG_VIEW_HEIGHT = 20;

export function App() {
  const { status, error, loading, refresh } = useDaemon({ intervalMs: 2500 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [view, setView] = useState<View>("servers");
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [filterText, setFilterText] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [claudeSelectedIndex, setClaudeSelectedIndex] = useState(0);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [permissionIndex, setPermissionIndex] = useState(0);

  const servers = status?.servers ?? [];
  // Poll faster on claude tab, slower off-tab (badge still updates)
  const {
    sessions,
    loading: claudeLoading,
    error: claudeError,
  } = useClaudeSessions({ intervalMs: view === "claude" ? 2500 : 10_000 });
  const {
    lines: logLines,
    source: logSource,
    setSource: setLogSource,
  } = useLogs(servers, { enabled: view === "logs" });

  const filteredLogLines = useMemo(() => filterLogLines(logLines, filterText), [logLines, filterText]);
  const prevFilterRef = useRef(filterText);

  // Auto-scroll: follow new lines at the tail, or force-jump when filter changes
  useEffect(() => {
    const filterChanged = prevFilterRef.current !== filterText;
    prevFilterRef.current = filterText;

    const maxOffset = Math.max(0, filteredLogLines.length - LOG_VIEW_HEIGHT);
    setLogScrollOffset((prev) => {
      if (filterChanged) return maxOffset;
      if (prev >= maxOffset - 1 || prev === 0) return maxOffset;
      return prev;
    });
  }, [filteredLogLines.length, filterText]);

  // Clamp claudeSelectedIndex when sessions list shrinks
  useEffect(() => {
    setClaudeSelectedIndex((i) => Math.min(i, Math.max(0, sessions.length - 1)));
  }, [sessions.length]);

  // Clamp permission index when selected session or permission count changes
  const selectedSessionId = sessions[claudeSelectedIndex]?.sessionId;
  const permCount = sessions[claudeSelectedIndex]?.pendingPermissionDetails?.length ?? 0;
  const prevSessionRef = useRef(selectedSessionId);
  useEffect(() => {
    if (prevSessionRef.current !== selectedSessionId) {
      prevSessionRef.current = selectedSessionId;
      setPermissionIndex(0);
    } else {
      setPermissionIndex((i) => Math.min(i, Math.max(0, permCount - 1)));
    }
  }, [selectedSessionId, permCount]);

  // Auto-clear success/error auth status after 5 seconds
  useEffect(() => {
    if (authStatus && authStatus.state !== "pending") {
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
      authTimerRef.current = setTimeout(() => setAuthStatus(null), 5000);
    }
    return () => {
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
    };
  }, [authStatus]);

  useKeyboard({
    view,
    setView,
    serversNav: {
      servers,
      selectedIndex,
      setSelectedIndex,
      expandedServer,
      setExpandedServer,
      refresh,
      authStatus,
      setAuthStatus,
    },
    logsNav: {
      logSource,
      setLogSource,
      logScrollOffset,
      setLogScrollOffset,
      logLineCount: filteredLogLines.length,
      filterMode,
      setFilterMode,
      filterText,
      setFilterText,
    },
    claudeNav: {
      sessions,
      selectedIndex: claudeSelectedIndex,
      setSelectedIndex: setClaudeSelectedIndex,
      expandedSession,
      setExpandedSession,
      permissionIndex,
      setPermissionIndex,
    },
  });

  if (loading && !status) return <Loading />;

  const needsAuth = servers.filter((s) => s.state === "error" && isAuthError(s.lastError));
  const pendingPermissionCount = sessions.reduce((n, s) => n + s.pendingPermissions, 0);
  const errorServerCount = servers.filter((s) => s.state === "error").length;
  const badges = buildBadges({ sessionCount: sessions.length, pendingPermissionCount, errorServerCount });

  return (
    <Box flexDirection="column" padding={1}>
      <Header status={status} error={error} />
      <TabBar activeTab={view} badges={badges} />
      {view === "servers" ? (
        <>
          {(needsAuth.length > 0 || authStatus) && <AuthBanner servers={needsAuth} authStatus={authStatus} />}
          <ServerList
            servers={servers}
            selectedIndex={selectedIndex}
            expandedServer={expandedServer}
            usageStats={status?.usageStats ?? []}
          />
        </>
      ) : view === "logs" ? (
        <LogViewer
          lines={filteredLogLines}
          source={logSource}
          servers={servers}
          scrollOffset={logScrollOffset}
          height={LOG_VIEW_HEIGHT}
          filterText={filterText}
          totalCount={logLines.length}
        />
      ) : view === "claude" ? (
        <ClaudeSessionList
          sessions={sessions}
          selectedIndex={claudeSelectedIndex}
          expandedSession={expandedSession}
          loading={claudeLoading}
          error={claudeError}
          permissionIndex={permissionIndex}
        />
      ) : (
        <Box marginTop={1}>
          <Text dimColor>Coming soon — see #181</Text>
        </Box>
      )}
      <Footer view={view} filterMode={filterMode} filterText={filterText} />
    </Box>
  );
}
