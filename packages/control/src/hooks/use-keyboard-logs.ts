import type { ServerStatus } from "@mcp-cli/core";
import type { Key } from "ink";
import type { LogsNav } from "./use-keyboard";
import { buildLogSources } from "./use-logs";

/**
 * Handle keyboard input for the logs view.
 * Returns true if the input was consumed.
 */
export function handleLogsInput(input: string, key: Key, nav: LogsNav, servers: ServerStatus[]): boolean {
  const {
    logSource,
    setLogSource,
    setLogScrollOffset,
    logLineCount,
    filterMode,
    setFilterMode,
    filterText,
    setFilterText,
  } = nav;

  // -- Filter mode: capture all input for filter text --
  if (filterMode) {
    if (key.return) {
      setFilterMode(false);
      return true;
    }
    if (key.escape) {
      setFilterText("");
      setFilterMode(false);
      return true;
    }
    if (key.backspace || key.delete) {
      setFilterText((prev) => prev.slice(0, -1));
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilterText((prev) => prev + input);
    }
    return true;
  }

  // Enter filter mode
  if (input === "f" || input === "/") {
    setFilterMode(true);
    return true;
  }

  // Scroll up
  if (key.upArrow || input === "k") {
    setLogScrollOffset((o) => Math.max(0, o - 1));
    return true;
  }

  // Scroll down
  if (key.downArrow || input === "j") {
    setLogScrollOffset((o) => Math.min(Math.max(0, logLineCount - 1), o + 1));
    return true;
  }

  // Cycle log source (t key, since Tab now cycles tabs)
  if (input === "t") {
    const sources = buildLogSources(servers);
    const currentIdx = sources.findIndex((src) => {
      if (src.type === "daemon" && logSource.type === "daemon") return true;
      if (src.type === "server" && logSource.type === "server" && src.name === logSource.name) return true;
      return false;
    });
    const nextIdx = (currentIdx + 1) % sources.length;
    setLogSource(sources[nextIdx]);
    setLogScrollOffset(() => 0);
    return true;
  }

  return false;
}
