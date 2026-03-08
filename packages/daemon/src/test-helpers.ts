/**
 * Shared test helpers for daemon spec files.
 */
import { mock } from "bun:test";
import type { ConfigSource, ResolvedConfig, ResolvedServer, ServerConfig } from "@mcp-cli/core";

export const testSource: ConfigSource = { file: "/test", scope: "user" };

/** Build a minimal ResolvedConfig for testing. */
export function makeConfig(servers: Record<string, ServerConfig>): ResolvedConfig {
  const map = new Map<string, ResolvedServer>();
  for (const [name, config] of Object.entries(servers)) {
    map.set(name, { name, config, source: testSource });
  }
  return { servers: map, sources: [] };
}

export function makeMockTransport() {
  return {
    close: mock(() => Promise.resolve()),
    start: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((err: Error) => void) | undefined,
  };
}
