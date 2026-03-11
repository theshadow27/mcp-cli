import { ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";
import type { ServersNav } from "./use-keyboard";

/**
 * Handle keyboard input for the servers view.
 * Returns true if the input was consumed.
 */
export function handleServersInput(input: string, key: Key, nav: ServersNav): boolean {
  const {
    servers,
    selectedIndex,
    setSelectedIndex,
    expandedServer,
    setExpandedServer,
    refresh,
    authStatus,
    setAuthStatus,
  } = nav;

  // Navigation
  if (key.upArrow || input === "k") {
    setSelectedIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    setSelectedIndex((i) => Math.min(servers.length - 1, i + 1));
    return true;
  }

  // Toggle detail view
  if (key.return) {
    const server = servers[selectedIndex];
    if (server) {
      setExpandedServer(expandedServer === server.name ? null : server.name);
    }
    return true;
  }

  // Trigger auth for selected server
  if (input === "a") {
    if (authStatus?.state === "pending") return true;
    const server = servers[selectedIndex];
    if (!server) return true;
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
    return true;
  }

  // Restart selected server
  if (input === "r") {
    const server = servers[selectedIndex];
    if (server) {
      ipcCall("restartServer", { server: server.name })
        .then(refresh)
        .catch(() => {});
    }
    return true;
  }

  // Restart all servers
  if (input === "R") {
    ipcCall("restartServer", {})
      .then(refresh)
      .catch(() => {});
    return true;
  }

  return false;
}
