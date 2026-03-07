/**
 * Config file watcher with debounced hot-reload.
 *
 * Watches the config source files (e.g., ~/.claude.json, .mcp.json) for changes.
 * On change, reloads config, compares hash, and invokes a callback with change details.
 */

import { type FSWatcher, existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { ResolvedConfig, ResolvedServer } from "@mcp-cli/core";
import { options, projectConfigPath } from "@mcp-cli/core";
import { configHash, loadConfig } from "./loader";

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
  private previousServers: Map<string, ResolvedServer>;
  private cwd: string;
  private callback: ConfigChangeCallback;
  private stopped = false;

  constructor(initialConfig: ResolvedConfig, callback: ConfigChangeCallback, cwd = process.cwd()) {
    this.currentHash = configHash(initialConfig);
    this.previousServers = initialConfig.servers;
    this.callback = callback;
    this.cwd = cwd;
  }

  /** Compare two server maps and return the diff. */
  static diffServers(
    oldServers: Map<string, ResolvedServer>,
    newServers: Map<string, ResolvedServer>,
  ): { added: string[]; removed: string[]; changed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const [name, resolved] of newServers) {
      const prev = oldServers.get(name);
      if (!prev) {
        added.push(name);
      } else if (!Bun.deepEquals(prev.config, resolved.config)) {
        changed.push(name);
      }
    }

    for (const name of oldServers.keys()) {
      if (!newServers.has(name)) {
        removed.push(name);
      }
    }

    return { added, removed, changed };
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

    // Watch mcp-cli's own config files only
    paths.add(options.USER_SERVERS_PATH);
    paths.add(projectConfigPath(this.cwd));

    return [...paths];
  }

  /**
   * Set up fs.watch on the parent directory of a config file.
   *
   * Always watches the directory rather than the file itself because many
   * editors perform atomic saves (write tmp → rename), which replaces the
   * file's inode and silently breaks a direct `fs.watch(file)` handle.
   */
  private watchFile(filePath: string): void {
    this.watchDirectory(filePath);
  }

  /** Watch a parent directory for file creation/modification. */
  private watchDirectory(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) return;
    try {
      const basename = filePath.split("/").pop() ?? "";
      const watcher = watch(dir, (_event, filename) => {
        // Match the target file directly, or any temp file variant (e.g. foo.json.tmp)
        // that editors create for atomic saves (write tmp → rename over target).
        // On Linux, rename() may report the source filename instead of the target,
        // and some kernels report null. The reload() hash check prevents false positives.
        if (!filename || filename === basename || filename.startsWith(basename)) {
          this.scheduleReload();
        }
      });
      this.watchers.push(watcher);
    } catch {
      // Directory not watchable — skip silently
    }
  }

  /** Force an immediate config reload, bypassing debounce. */
  async forceReload(): Promise<void> {
    await this.reload();
  }

  /** Schedule a debounced config reload. */
  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped) return;
      this.reload();
    }, DEBOUNCE_MS);
  }

  /** Reload config and fire callback if hash changed. */
  private async reload(): Promise<void> {
    if (this.stopped) return;
    try {
      const config = await loadConfig(this.cwd);
      const hash = configHash(config);

      if (hash === this.currentHash) return;

      const previousHash = this.currentHash;
      const { added, removed, changed } = ConfigWatcher.diffServers(this.previousServers, config.servers);
      this.currentHash = hash;
      this.previousServers = config.servers;
      console.error(`[config-watcher] Config changed (${previousHash.slice(0, 8)} → ${hash.slice(0, 8)}), reloading`);
      this.callback({ added, removed, changed, config, hash });
    } catch (err) {
      console.error(`[config-watcher] Failed to reload config: ${err}`);
    }
  }
}
