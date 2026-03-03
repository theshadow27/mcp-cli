import { Box } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { AuthBanner, type AuthStatus, isAuthError } from "./components/auth-banner.js";
import { Footer } from "./components/footer.js";
import { Header } from "./components/header.js";
import { Loading } from "./components/loading.js";
import { LogViewer } from "./components/log-viewer.js";
import { ServerList } from "./components/server-list.js";
import { useDaemon } from "./hooks/use-daemon.js";
import type { View } from "./hooks/use-keyboard.js";
import { useKeyboard } from "./hooks/use-keyboard.js";
import { useLogs } from "./hooks/use-logs.js";

const LOG_VIEW_HEIGHT = 20;

export function App() {
  const { status, error, loading, refresh } = useDaemon(2500);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [view, setView] = useState<View>("servers");
  const [logScrollOffset, setLogScrollOffset] = useState(0);

  const servers = status?.servers ?? [];
  const { lines: logLines, source: logSource, setSource: setLogSource } = useLogs(servers);

  // Auto-scroll to bottom when new lines arrive and user is following
  useEffect(() => {
    const maxOffset = Math.max(0, logLines.length - LOG_VIEW_HEIGHT);
    setLogScrollOffset((prev) => {
      // If already at or past the end, follow new lines
      if (prev >= maxOffset - 1 || prev === 0) return maxOffset;
      return prev;
    });
  }, [logLines.length]);

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
    logLineCount: logLines.length,
  });

  if (loading && !status) return <Loading />;

  const needsAuth = servers.filter((s) => s.state === "error" && isAuthError(s.lastError));

  return (
    <Box flexDirection="column" padding={1}>
      <Header status={status} error={error} />
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
      ) : (
        <LogViewer
          lines={logLines}
          source={logSource}
          servers={servers}
          scrollOffset={logScrollOffset}
          height={LOG_VIEW_HEIGHT}
        />
      )}
      <Footer view={view} />
    </Box>
  );
}
