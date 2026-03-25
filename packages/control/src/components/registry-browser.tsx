import { Box, Text } from "ink";
import React from "react";
import type { RegistryEntry, TransportSelection } from "../hooks/registry-client.js";
import type { RegistryMode } from "../hooks/use-keyboard-registry.js";

interface RegistryBrowserProps {
  entries: RegistryEntry[];
  selectedIndex: number;
  expandedEntry: string | null;
  loading: boolean;
  error: string | null;
  searchText: string;
  mode: RegistryMode;
  statusMessage: string | null;
  /** Install flow state */
  installTarget: RegistryEntry | null;
  installTransport: TransportSelection | null;
  envInputs: Record<string, string>;
  envCursor: number;
  envEditBuffer: string;
  installScope: "user" | "project";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function EntryRow({ entry, selected, expanded }: { entry: RegistryEntry; selected: boolean; expanded: boolean }) {
  const meta = entry._meta["com.anthropic.api/mcp-registry"];
  const toolCount = meta.toolNames?.length ?? 0;
  const prefix = selected ? "❯ " : "  ";

  return (
    <Box flexDirection="column">
      <Text>
        {prefix}
        <Text color="cyan" bold={selected}>
          {meta.slug}
        </Text>
        {"  "}
        <Text bold>{meta.displayName}</Text>
        {"  "}
        <Text dimColor>{truncate(meta.oneLiner, 50)}</Text>
        {"  "}
        <Text color="gray">{toolCount} tools</Text>
      </Text>
      {expanded && <EntryDetail entry={entry} />}
    </Box>
  );
}

function EntryDetail({ entry }: { entry: RegistryEntry }) {
  const meta = entry._meta["com.anthropic.api/mcp-registry"];
  const { server } = entry;
  const transports: string[] = [];
  if (server.remotes) {
    for (const r of server.remotes) transports.push(r.type);
  }
  if (server.packages) {
    for (const _p of server.packages) transports.push("stdio");
  }

  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      <Text>{server.description}</Text>
      {transports.length > 0 && (
        <Text>
          <Text dimColor>Transports:</Text> {transports.join(", ")}
        </Text>
      )}
      {meta.toolNames && meta.toolNames.length > 0 && (
        <Text>
          <Text dimColor>Tools:</Text> {meta.toolNames.join(", ")}
        </Text>
      )}
      {meta.documentation && (
        <Text>
          <Text dimColor>Docs:</Text> {meta.documentation}
        </Text>
      )}
      <Text dimColor>Press i to install</Text>
    </Box>
  );
}

function EnvInputForm({
  transport,
  envInputs,
  envCursor,
  envEditBuffer,
}: {
  transport: TransportSelection;
  envInputs: Record<string, string>;
  envCursor: number;
  envEditBuffer: string;
}) {
  const requiredVars = transport.envVars?.filter((v) => v.isRequired) ?? [];
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>Environment Variables</Text>
      {requiredVars.map((v, i) => {
        const isCurrent = i === envCursor;
        const value = isCurrent ? envEditBuffer : (envInputs[v.name] ?? "");
        return (
          <Text key={v.name}>
            {isCurrent ? "❯ " : "  "}
            <Text color={isCurrent ? "cyan" : undefined}>{v.name}</Text>
            {": "}
            {value}
            {isCurrent && <Text dimColor>█</Text>}
            {v.description && <Text dimColor> ({v.description})</Text>}
          </Text>
        );
      })}
      <Text dimColor>enter/tab next esc cancel</Text>
    </Box>
  );
}

function ScopePickForm({ scope }: { scope: "user" | "project" }) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>Install Scope</Text>
      <Text>
        {scope === "user" ? "❯ " : "  "}
        <Text color={scope === "user" ? "cyan" : undefined}>user</Text>
        <Text dimColor> (~/.mcp-cli/servers.json)</Text>
      </Text>
      <Text>
        {scope === "project" ? "❯ " : "  "}
        <Text color={scope === "project" ? "cyan" : undefined}>project</Text>
        <Text dimColor> (.mcp/servers.json)</Text>
      </Text>
      <Text dimColor>j/k select enter confirm esc cancel</Text>
    </Box>
  );
}

function ConfirmInstallForm({
  entry,
  transport,
  envInputs,
  scope,
}: {
  entry: RegistryEntry;
  transport: TransportSelection;
  envInputs: Record<string, string>;
  scope: "user" | "project";
}) {
  const slug = entry._meta["com.anthropic.api/mcp-registry"].slug;
  const envEntries = Object.entries(envInputs).filter(([, v]) => v.length > 0);
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>Confirm Install</Text>
      <Text>
        <Text dimColor>Server:</Text> {slug}
      </Text>
      <Text>
        <Text dimColor>Transport:</Text> {transport.transport}
        {transport.url && ` (${transport.url})`}
        {transport.command && ` (${transport.command} ${transport.commandArgs?.join(" ") ?? ""})`}
      </Text>
      {envEntries.length > 0 && (
        <Text>
          <Text dimColor>Env:</Text> {envEntries.map(([k]) => k).join(", ")}
        </Text>
      )}
      <Text>
        <Text dimColor>Scope:</Text> {scope}
      </Text>
      <Text dimColor>enter/y install esc/n cancel</Text>
    </Box>
  );
}

export function RegistryBrowser({
  entries,
  selectedIndex,
  expandedEntry,
  loading,
  error,
  searchText,
  mode,
  statusMessage,
  installTarget,
  installTransport,
  envInputs,
  envCursor,
  envEditBuffer,
  installScope,
}: RegistryBrowserProps) {
  // Install flow overlays
  if (mode === "env-input" && installTransport) {
    return (
      <EnvInputForm
        transport={installTransport}
        envInputs={envInputs}
        envCursor={envCursor}
        envEditBuffer={envEditBuffer}
      />
    );
  }

  if (mode === "scope-pick") {
    return <ScopePickForm scope={installScope} />;
  }

  if (mode === "confirm-install" && installTarget && installTransport) {
    return (
      <ConfirmInstallForm
        entry={installTarget}
        transport={installTransport}
        envInputs={envInputs}
        scope={installScope}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {/* Search bar */}
      <Box>
        <Text>
          <Text color="cyan">search:</Text>{" "}
          {mode === "search" ? (
            <>
              {searchText}
              <Text dimColor>█</Text>
            </>
          ) : searchText ? (
            <Text dimColor>{searchText}</Text>
          ) : (
            <Text dimColor>(press / or f to search)</Text>
          )}
        </Text>
      </Box>

      {/* Status */}
      {statusMessage && <Text color="yellow">{statusMessage}</Text>}
      {error && <Text color="red">{error}</Text>}
      {loading && <Text dimColor>Loading...</Text>}

      {/* Results */}
      {!loading && entries.length === 0 && !error && (
        <Text dimColor>No results. Press / to search or wait for popular servers to load.</Text>
      )}
      {entries.map((entry, i) => {
        const slug = entry._meta["com.anthropic.api/mcp-registry"].slug;
        return <EntryRow key={slug} entry={entry} selected={i === selectedIndex} expanded={expandedEntry === slug} />;
      })}
      {entries.length > 0 && <Text dimColor>{entries.length} server(s)</Text>}
    </Box>
  );
}
