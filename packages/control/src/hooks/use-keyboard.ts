import type { ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useApp, useInput } from "ink";

interface UseKeyboardOptions {
  servers: ServerStatus[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedServer: string | null;
  setExpandedServer: (name: string | null) => void;
  refresh: () => void;
}

export function useKeyboard({
  servers,
  selectedIndex,
  setSelectedIndex,
  expandedServer,
  setExpandedServer,
  refresh,
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
