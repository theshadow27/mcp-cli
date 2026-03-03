import type { ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useApp, useInput } from "ink";
import type { AuthStatus } from "../components/auth-banner.js";

interface UseKeyboardOptions {
  servers: ServerStatus[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedServer: string | null;
  setExpandedServer: (name: string | null) => void;
  refresh: () => void;
  authStatus: AuthStatus | null;
  setAuthStatus: (status: AuthStatus | null) => void;
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
}: UseKeyboardOptions): void {
  const { exit } = useApp();

  useInput((input, key) => {
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

    // Shutdown daemon
    if (input === "s") {
      ipcCall("shutdown").catch(() => {});
      exit();
      return;
    }

    // Quit
    if (input === "q") {
      exit();
    }
  });
}
