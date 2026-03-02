/**
 * Config file watcher with debounced hot-reload.
 *
 * Watches the config source files (e.g., ~/.claude.json, .mcp.json) for changes.
 * On change, reloads config, compares hash, and invokes a callback with change details.
 */

import { type FSWatcher, existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { ResolvedConfig } from "@mcp-cli/core";
import { CLAUDE_CONFIG_PATH, PROJECT_MCP_FILENAME, USER_SERVERS_PATH } from "@mcp-cli/core";
import { configHash, loadConfig } from "./loader.js";

const DEBOUNCE_MS = 300;

export interface ConfigChangeEvent {
  added: string[];
  removed: string[];
  changed: string[];
  config: ResolvedConfig;
  hash: string;
}

export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

export class ConfigWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimer: Timer | null = null;
  private currentHash: string;
  private cwd: string;
  private callback: ConfigChangeCallback;
  private stopped = false;

  constructor(initialConfig: ResolvedConfig, callback: ConfigChangeCallback, cwd = process.cwd()) {
    this.currentHash = configHash(initialConfig);
    this.callback = callback;
    this.cwd = cwd;
  }

  /** Start watching config files. */
  start(): void {
    const paths = this.getWatchPaths();
    for (const filePath of paths) {
      this.watchFile(filePath);
    }
    console.error(`[config-watcher] Watching ${paths.length} config paths`);
  }

  /** Stop all watchers and cancel pending debounce. */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
  }

  /** Collect the set of config file paths to watch. */
  private getWatchPaths(): string[] {
    const paths = new Set<string>();

    // Always watch the standard config locations
    paths.add(CLAUDE_CONFIG_PATH);
    paths.add(USER_SERVERS_PATH);

    // Watch .mcp.json in CWD (or parent chain — but we just watch CWD for simplicity)
    const projectMcp = `${this.cwd}/${PROJECT_MCP_FILENAME}`;
    paths.add(projectMcp);

    return [...paths];
  }

  /** Set up fs.watch on a file (or its parent directory if it doesn't exist yet). */
  private watchFile(filePath: string): void {
    if (existsSync(filePath)) {
      // Watch the file directly
      try {
        const watcher = watch(filePath, () => this.scheduleReload());
        this.watchers.push(watcher);
      } catch {
        // Fall back to watching the directory
        this.watchDirectory(filePath);
      }
    } else {
      // File doesn't exist yet — watch the parent directory for creation
      this.watchDirectory(filePath);
    }
  }

  /** Watch a parent directory for file creation/modification. */
  private watchDirectory(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) return;
    try {
      const basename = filePath.split("/").pop() ?? "";
      const watcher = watch(dir, (_event, filename) => {
        if (filename === basename) this.scheduleReload();
      });
      this.watchers.push(watcher);
    } catch {
      // Directory not watchable — skip silently
    }
  }

  /** Schedule a debounced config reload. */
  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(), DEBOUNCE_MS);
  }

  /** Reload config and fire callback if hash changed. */
  private async reload(): Promise<void> {
    if (this.stopped) return;
    try {
      const config = await loadConfig(this.cwd);
      const hash = configHash(config);

      if (hash === this.currentHash) return;

      const previousHash = this.currentHash;
      this.currentHash = hash;
      console.error(`[config-watcher] Config changed (${previousHash.slice(0, 8)} → ${hash.slice(0, 8)}), reloading`);
      this.callback({ added: [], removed: [], changed: [], config, hash });
    } catch (err) {
      console.error(`[config-watcher] Failed to reload config: ${err}`);
    }
  }
}
