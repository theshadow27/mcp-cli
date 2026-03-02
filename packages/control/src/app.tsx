import { Box } from "ink";
import React, { useState } from "react";
import { AuthBanner, isAuthError } from "./components/auth-banner.js";
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

  const servers = status?.servers ?? [];

  useKeyboard({
    servers,
    selectedIndex,
    setSelectedIndex,
    expandedServer,
    setExpandedServer,
    refresh,
  });

  if (loading && !status) return <Loading />;

  const needsAuth = servers.filter((s) => s.state === "error" && isAuthError(s.lastError));

  return (
    <Box flexDirection="column" padding={1}>
      <Header status={status} error={error} />
      {needsAuth.length > 0 && <AuthBanner servers={needsAuth} />}
      <ServerList servers={servers} selectedIndex={selectedIndex} expandedServer={expandedServer} />
      <Footer />
    </Box>
  );
}
