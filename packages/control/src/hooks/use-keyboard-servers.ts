import { addServerToConfig, ipcCall, removeServerFromConfig } from "@mcp-cli/core";
import type { ServerConfig } from "@mcp-cli/core";
import type { Key } from "ink";
import {
  ADD_SERVER_STEPS,
  type AddServerScope,
  type AddServerState,
  type AddServerTransport,
  initialAddServerState,
} from "../components/server-add-form";
import type { ServersNav } from "./use-keyboard";

const TRANSPORT_OPTIONS: AddServerTransport[] = ["http", "sse", "stdio"];
const SCOPE_OPTIONS: AddServerScope[] = ["user", "project"];

/** Build a ServerConfig from add-server form state. Exported for testing. */
export function buildConfig(state: AddServerState): ServerConfig {
  const envObj: Record<string, string> = {};
  for (const entry of state.env) {
    const eq = entry.indexOf("=");
    if (eq > 0) {
      envObj[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }

  if (state.transport === "stdio") {
    const parts = state.url.split(/\s+/).filter(Boolean);
    const config: ServerConfig = {
      command: parts[0],
      args: parts.slice(1),
    };
    if (Object.keys(envObj).length > 0) config.env = envObj;
    return config;
  }

  const config: ServerConfig = {
    type: state.transport,
    url: state.url,
  };
  if (Object.keys(envObj).length > 0) {
    return { ...config, env: envObj } as ServerConfig;
  }
  return config;
}

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
    addServerMode,
    setAddServerMode,
    addServerState,
    setAddServerState,
    confirmRemove,
    setConfirmRemove,
    configInfo,
    onAddServer,
    onRemoveServer,
  } = nav;

  // ── Confirm remove mode ──
  if (confirmRemove) {
    if (input === "y") {
      const server = servers[selectedIndex];
      if (server) {
        const info = configInfo[server.name];
        if (!info) {
          // configInfo not loaded yet — cannot determine scope, abort removal
          setConfirmRemove(false);
          return true;
        }
        const scope = (info.scope === "project" ? "project" : "user") as "user" | "project";
        (onRemoveServer ?? removeServerFromConfig)(scope, server.name);
        // Force daemon to reload config
        ipcCall("reloadConfig")
          .then(refresh)
          .catch(() => {});
      }
      setConfirmRemove(false);
      return true;
    }
    if (input === "n" || key.escape) {
      setConfirmRemove(false);
      return true;
    }
    return true; // swallow all other input in confirm mode
  }

  // ── Add server mode ──
  if (addServerMode) {
    return handleAddServerInput(input, key, nav);
  }

  // Navigation
  if (key.upArrow || input === "k") {
    setSelectedIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    setSelectedIndex((i) => Math.min(Math.max(0, servers.length - 1), i + 1));
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

  // Add server
  if (input === "n" || input === "+") {
    setAddServerMode(true);
    setAddServerState(initialAddServerState());
    return true;
  }

  // Remove server
  if (input === "d" || input === "x") {
    const server = servers[selectedIndex];
    if (server) {
      setConfirmRemove(true);
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

/** Handle input within the add-server multi-step form. */
function handleAddServerInput(input: string, key: Key, nav: ServersNav): boolean {
  const { addServerState: state, setAddServerState, setAddServerMode, refresh, onAddServer } = nav;

  // Cancel at any step
  if (key.escape) {
    setAddServerMode(false);
    return true;
  }

  const { step } = state;

  // ── Transport picker ──
  if (step === "transport") {
    if (key.upArrow || input === "k") {
      const idx = TRANSPORT_OPTIONS.indexOf(state.transport);
      const next = TRANSPORT_OPTIONS[Math.max(0, idx - 1)];
      setAddServerState({ ...state, transport: next });
      return true;
    }
    if (key.downArrow || input === "j") {
      const idx = TRANSPORT_OPTIONS.indexOf(state.transport);
      const next = TRANSPORT_OPTIONS[Math.min(TRANSPORT_OPTIONS.length - 1, idx + 1)];
      setAddServerState({ ...state, transport: next });
      return true;
    }
    if (key.return) {
      setAddServerState({ ...state, step: "name" });
      return true;
    }
    return true;
  }

  // ── Name input ──
  if (step === "name") {
    if (key.return) {
      if (state.name.trim().length > 0) {
        setAddServerState({ ...state, step: "url" });
      }
      return true;
    }
    if (key.backspace || key.delete) {
      setAddServerState({ ...state, name: state.name.slice(0, -1) });
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setAddServerState({ ...state, name: state.name + input });
      return true;
    }
    return true;
  }

  // ── URL/Command input ──
  if (step === "url") {
    if (key.return) {
      if (state.url.trim().length > 0) {
        setAddServerState({ ...state, step: "env" });
      }
      return true;
    }
    if (key.backspace || key.delete) {
      setAddServerState({ ...state, url: state.url.slice(0, -1) });
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setAddServerState({ ...state, url: state.url + input });
      return true;
    }
    return true;
  }

  // ── Env var input ──
  if (step === "env") {
    // Tab → skip to scope
    if (key.tab) {
      setAddServerState({ ...state, envInput: "", step: "scope" });
      return true;
    }
    if (key.return) {
      if (state.envInput.trim().length > 0 && state.envInput.includes("=")) {
        // Add the env var and clear input for next entry
        setAddServerState({
          ...state,
          env: [...state.env, state.envInput.trim()],
          envInput: "",
        });
      } else if (state.envInput.trim().length === 0) {
        // Empty enter → skip to scope
        setAddServerState({ ...state, envInput: "", step: "scope" });
      }
      return true;
    }
    if (key.backspace || key.delete) {
      setAddServerState({ ...state, envInput: state.envInput.slice(0, -1) });
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setAddServerState({ ...state, envInput: state.envInput + input });
      return true;
    }
    return true;
  }

  // ── Scope picker ──
  if (step === "scope") {
    if (key.upArrow || input === "k" || key.downArrow || input === "j") {
      setAddServerState({
        ...state,
        scope: state.scope === "user" ? "project" : "user",
      });
      return true;
    }
    if (key.return) {
      setAddServerState({ ...state, step: "confirm" });
      return true;
    }
    return true;
  }

  // ── Confirm ──
  if (step === "confirm") {
    if (key.return) {
      const config = buildConfig(state);
      (onAddServer ?? addServerToConfig)(state.scope, state.name, config);
      // Force daemon to reload config
      ipcCall("reloadConfig")
        .then(refresh)
        .catch(() => {});
      setAddServerMode(false);
      return true;
    }
    return true;
  }

  return true;
}
