import type { ServerConfig } from "@mcp-cli/core";
import { addServerToConfig, ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";
import type { RegistryEntry, TransportSelection } from "./registry-client";
import { selectTransport } from "./registry-client";

export type RegistryMode = "browse" | "search" | "env-input" | "scope-pick" | "confirm-install";

export interface RegistryNav {
  entries: RegistryEntry[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedEntry: string | null;
  setExpandedEntry: (slug: string | null) => void;
  searchText: string;
  setSearchText: (fn: string | ((prev: string) => string)) => void;
  mode: RegistryMode;
  setMode: (mode: RegistryMode) => void;
  onSearch: (query: string) => void;
  onLoadPopular: () => void;
  /** Install state */
  installTarget: RegistryEntry | null;
  setInstallTarget: (entry: RegistryEntry | null) => void;
  installTransport: TransportSelection | null;
  setInstallTransport: (t: TransportSelection | null) => void;
  envInputs: Record<string, string>;
  setEnvInputs: (fn: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
  envCursor: number;
  setEnvCursor: (fn: number | ((prev: number) => number)) => void;
  envEditBuffer: string;
  setEnvEditBuffer: (fn: string | ((prev: string) => string)) => void;
  installScope: "user" | "project";
  setInstallScope: (scope: "user" | "project") => void;
  statusMessage: string | null;
  setStatusMessage: (msg: string | null) => void;
  /** DI for testing */
  onAddServer?: (scope: "user" | "project", name: string, config: ServerConfig) => void;
}

/** Build a ServerConfig from a transport selection and env overrides. */
export function buildInstallConfig(selection: TransportSelection, envOverrides: Record<string, string>): ServerConfig {
  if (selection.kind === "remote") {
    const url = selection.url ?? "";
    if (selection.transport === "http") return { type: "http", url };
    return { type: "sse", url };
  }

  const config: ServerConfig = {
    command: selection.command ?? "",
    args: selection.commandArgs,
  };

  const envVars = selection.envVars?.filter((v) => v.isRequired) ?? [];
  if (envVars.length > 0 || Object.keys(envOverrides).length > 0) {
    const env: Record<string, string> = {};
    for (const v of envVars) env[v.name] = "";
    Object.assign(env, envOverrides);
    (config as { env?: Record<string, string> }).env = env;
  }

  return config;
}

export function handleRegistryInput(input: string, key: Key, nav: RegistryNav): boolean {
  const { entries, selectedIndex, expandedEntry, mode } = nav;

  // ── Search mode: capture text input ──
  if (mode === "search") {
    if (key.escape) {
      nav.setMode("browse");
      return true;
    }
    if (key.return) {
      const query = nav.searchText.trim();
      if (query.length > 0) {
        nav.onSearch(query);
      } else {
        nav.onLoadPopular();
      }
      nav.setMode("browse");
      return true;
    }
    if (key.backspace || key.delete) {
      nav.setSearchText((prev) => prev.slice(0, -1));
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      nav.setSearchText((prev) => prev + input);
      return true;
    }
    return true;
  }

  // ── Env var input mode ──
  if (mode === "env-input") {
    return handleEnvInput(input, key, nav);
  }

  // ── Scope pick mode ──
  if (mode === "scope-pick") {
    if (key.escape) {
      nav.setMode("browse");
      nav.setInstallTarget(null);
      return true;
    }
    if (key.upArrow || input === "k" || key.downArrow || input === "j") {
      nav.setInstallScope(nav.installScope === "user" ? "project" : "user");
      return true;
    }
    if (key.return) {
      nav.setMode("confirm-install");
      return true;
    }
    return true;
  }

  // ── Confirm install mode ──
  if (mode === "confirm-install") {
    if (key.escape || input === "n") {
      nav.setMode("browse");
      nav.setInstallTarget(null);
      return true;
    }
    if (input === "y" || key.return) {
      doInstall(nav);
      return true;
    }
    return true;
  }

  // ── Browse mode ──

  // Open search
  if (input === "/" || input === "f") {
    nav.setSearchText(() => "");
    nav.setMode("search");
    return true;
  }

  // Navigate list
  if (key.upArrow || input === "k") {
    nav.setSelectedIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    nav.setSelectedIndex((i) => Math.min(Math.max(0, entries.length - 1), i + 1));
    return true;
  }

  // Toggle detail
  if (key.return) {
    const entry = entries[selectedIndex];
    if (!entry) return false;
    const slug = entry._meta["com.anthropic.api/mcp-registry"].slug;
    nav.setExpandedEntry(expandedEntry === slug ? null : slug);
    return true;
  }

  // Install
  if (input === "i") {
    const entry = entries[selectedIndex];
    if (!entry) return true;
    const transport = selectTransport(entry);
    if (!transport) {
      nav.setStatusMessage("No installable transport found for this server");
      return true;
    }
    if (transport.kind === "templated") {
      nav.setStatusMessage("Server requires manual configuration (templated URL)");
      return true;
    }
    nav.setInstallTarget(entry);
    nav.setInstallTransport(transport);
    nav.setStatusMessage(null);

    // If env vars needed, go to env input; otherwise go to scope pick
    const requiredEnvVars = transport.envVars?.filter((v) => v.isRequired) ?? [];
    if (requiredEnvVars.length > 0) {
      const initial: Record<string, string> = {};
      for (const v of requiredEnvVars) initial[v.name] = "";
      nav.setEnvInputs(initial);
      nav.setEnvCursor(() => 0);
      nav.setEnvEditBuffer(() => "");
      nav.setMode("env-input");
    } else {
      nav.setEnvInputs({});
      nav.setInstallScope("user");
      nav.setMode("scope-pick");
    }
    return true;
  }

  return false;
}

function handleEnvInput(input: string, key: Key, nav: RegistryNav): boolean {
  const requiredVars = nav.installTransport?.envVars?.filter((v) => v.isRequired) ?? [];

  if (key.escape) {
    nav.setMode("browse");
    nav.setInstallTarget(null);
    return true;
  }

  // Tab or down arrow: save current and move to next var (or advance to scope pick)
  if (key.tab || key.return) {
    // Save current buffer to envInputs
    const varName = requiredVars[nav.envCursor]?.name;
    if (varName) {
      const buf = nav.envEditBuffer;
      nav.setEnvInputs((prev) => ({ ...prev, [varName]: buf }));
    }

    if (nav.envCursor >= requiredVars.length - 1) {
      // All vars done, advance to scope pick
      nav.setInstallScope("user");
      nav.setMode("scope-pick");
    } else {
      nav.setEnvCursor((c) => c + 1);
      // Load next var's current value into buffer
      const nextVar = requiredVars[nav.envCursor + 1]?.name;
      nav.setEnvEditBuffer(() => (nextVar ? (nav.envInputs[nextVar] ?? "") : ""));
    }
    return true;
  }

  if (key.backspace || key.delete) {
    nav.setEnvEditBuffer((prev) => prev.slice(0, -1));
    return true;
  }

  if (input && !key.ctrl && !key.meta) {
    nav.setEnvEditBuffer((prev) => prev + input);
    return true;
  }

  return true;
}

function doInstall(nav: RegistryNav): void {
  const { installTarget, installTransport, envInputs, installScope, onAddServer } = nav;
  if (!installTarget || !installTransport) return;

  const slug = installTarget._meta["com.anthropic.api/mcp-registry"].slug;
  const config = buildInstallConfig(installTransport, envInputs);

  (onAddServer ?? addServerToConfig)(installScope, slug, config);

  // Reload daemon config
  ipcCall("reloadConfig").catch(() => {});

  nav.setStatusMessage(`Installed "${slug}" to ${installScope} config`);
  nav.setMode("browse");
  nav.setInstallTarget(null);
}
