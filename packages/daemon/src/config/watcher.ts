/**
 * Config file watcher with debounced hot-reload.
 *
 * Watches the config source files (e.g., ~/.claude.json, .mcp.json) for changes.
 * On change, reloads config, compares hash, and invokes a callback with change details.
 */

import { type FSWatcher, existsSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { Logger, ResolvedConfig, ResolvedServer } from "@mcp-cli/core";
import { consoleLogger, options, projectConfigPath } from "@mcp-cli/core";
import { configHash, loadConfig as defaultLoadConfig } from "./loader";

const DEBOUNCE_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface ConfigChangeEvent {
  added: string[];
  removed: string[];
  changed: string[];
  config: ResolvedConfig;
  hash: string;
}

export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

export interface ConfigWatcherOptions {
  pollIntervalMs?: number;
  debounceMs?: number;
  loadConfig?: (cwd: string) => Promise<ResolvedConfig>;
  logger?: Logger;
}

export class ConfigWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimer: Timer | null = null;
  private pollTimer: Timer | null = null;
  private pollIntervalMs: number;
  private debounceMs: number;
  private loadConfigFn: (cwd: string) => Promise<ResolvedConfig>;
  private lastMtimes: Map<string, number> = new Map();
  private currentHash: string;
  private previousServers: Map<string, ResolvedServer>;
  private cwd: string;
  private callback: ConfigChangeCallback;
  private stopped = false;
  private logger: Logger;

  constructor(
    initialConfig: ResolvedConfig,
    callback: ConfigChangeCallback,
    cwd = process.cwd(),
    opts?: ConfigWatcherOptions,
  ) {
    this.currentHash = configHash(initialConfig);
    this.previousServers = initialConfig.servers;
    this.callback = callback;
    this.cwd = cwd;
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.debounceMs = opts?.debounceMs ?? DEBOUNCE_MS;
    this.loadConfigFn = opts?.loadConfig ?? defaultLoadConfig;
    this.logger = opts?.logger ?? consoleLogger;
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
    if (this.pollTimer) return;
    const paths = this.getWatchPaths();
    for (const filePath of paths) {
      this.watchFile(filePath);
    }

    // Initialize mtimes and start polling fallback
    for (const filePath of paths) {
      try {
        this.lastMtimes.set(filePath, statSync(filePath).mtimeMs);
      } catch {
        this.lastMtimes.set(filePath, 0);
      }
    }
    this.pollTimer = setInterval(() => this.pollCheck(), this.pollIntervalMs);

    this.logger.info(`[config-watcher] Watching ${paths.length} config paths`);
  }

  /** Stop all watchers and cancel pending debounce. */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
      const base = basename(filePath);
      const watcher = watch(dir, (_event, filename) => {
        // Match the target file directly, or any temp file variant (e.g. foo.json.tmp)
        // that editors create for atomic saves (write tmp → rename over target).
        // On Linux, rename() may report the source filename instead of the target,
        // and some kernels report null. The reload() hash check prevents false positives.
        if (!filename || filename === base || filename.startsWith(base)) {
          this.scheduleReload();
        }
      });
      this.watchers.push(watcher);
    } catch {
      // Directory not watchable — skip silently
    }
  }

  /** Poll watched paths for mtime changes as a fallback for unreliable fs.watch. */
  private pollCheck(): void {
    try {
      if (this.stopped) return;
      const paths = this.getWatchPaths();
      let changed = false;
      for (const filePath of paths) {
        let mtime = 0;
        try {
          mtime = statSync(filePath).mtimeMs;
        } catch {
          // File doesn't exist — treat as mtime 0
        }
        const last = this.lastMtimes.get(filePath) ?? 0;
        if (mtime !== last) {
          this.lastMtimes.set(filePath, mtime);
          changed = true;
        }
      }
      if (changed) {
        this.scheduleReload();
      }
    } catch (err) {
      this.logger.error(`[config-watcher] Poll check failed: ${err}`);
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
    }, this.debounceMs);
  }

  /** Reload config and fire callback if hash changed. */
  private async reload(): Promise<void> {
    if (this.stopped) return;
    try {
      const config = await this.loadConfigFn(this.cwd);
      const hash = configHash(config);

      if (hash === this.currentHash) return;

      const previousHash = this.currentHash;
      const { added, removed, changed } = ConfigWatcher.diffServers(this.previousServers, config.servers);
      this.currentHash = hash;
      this.previousServers = config.servers;
      this.logger.info(
        `[config-watcher] Config changed (${previousHash.slice(0, 8)} → ${hash.slice(0, 8)}), reloading`,
      );
      this.callback({ added, removed, changed, config, hash });

      // Refresh mtimes so the polling fallback doesn't redundantly trigger
      // for a change that fs.watch already handled.
      for (const filePath of this.getWatchPaths()) {
        try {
          this.lastMtimes.set(filePath, statSync(filePath).mtimeMs);
        } catch {
          this.lastMtimes.set(filePath, 0);
        }
      }
    } catch (err) {
      this.logger.error(`[config-watcher] Failed to reload config: ${err}`);
    }
  }
}
