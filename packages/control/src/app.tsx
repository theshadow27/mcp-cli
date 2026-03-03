import { Box } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { AuthBanner, type AuthStatus, isAuthError } from "./components/auth-banner.js";
import { Footer } from "./components/footer.js";
import { Header } from "./components/header.js";
import { Loading } from "./components/loading.js";
import { ServerList } from "./components/server-list.js";
import { useDaemon } from "./hooks/use-daemon.js";
import { useKeyboard } from "./hooks/use-keyboard.js";

export function App() {
  const { status, error, loading, refresh } = useDaemon(2500);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const servers = status?.servers ?? [];

  useKeyboard({
    servers,
    selectedIndex,
    setSelectedIndex,
    expandedServer,
    setExpandedServer,
    refresh,
    authStatus,
    setAuthStatus,
  });

  if (loading && !status) return <Loading />;

  const needsAuth = servers.filter((s) => s.state === "error" && isAuthError(s.lastError));

  return (
    <Box flexDirection="column" padding={1}>
      <Header status={status} error={error} />
      {(needsAuth.length > 0 || authStatus) && <AuthBanner servers={needsAuth} authStatus={authStatus} />}
      <ServerList servers={servers} selectedIndex={selectedIndex} expandedServer={expandedServer} />
      <Footer />
    </Box>
  );
}
