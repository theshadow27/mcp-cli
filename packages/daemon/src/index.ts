#!/usr/bin/env bun
/**
 * mcpd — MCP CLI daemon
 *
 * Manages MCP server connections, auth tokens, and tool caching.
 * Communicates with the `mcx` CLI via Unix socket IPC.
 *
 * Lifecycle:
 * 1. Read config from Claude Code / .mcp.json / ~/.mcp-cli
 * 2. Start IPC server on Unix socket
 * 3. Signal readiness to parent process
 * 4. Handle requests, connect to servers lazily
 * 5. Shut down on idle timeout or SIGTERM
 */

import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { NdjsonRecorder, workItemStateNamespace } from "@mcp-cli/core";
import type { Logger } from "@mcp-cli/core";
import {
  ACP_SERVER_NAME,
  ALIAS_SERVER_NAME,
  BUILD_VERSION,
  CLAUDE_SERVER_NAME,
  CODEX_SERVER_NAME,
  DAEMON_CONFIG_RELOADED,
  DAEMON_IDLE_TIMEOUT_MS,
  DAEMON_READY_SIGNAL,
  DAEMON_RESTARTED,
  DEFAULT_CLAUDE_WS_PORT,
  LOCKFILE_NAME,
  MAIL_SERVER_NAME,
  METRICS_SERVER_NAME,
  MOCK_SERVER_NAME,
  ManifestVersionError,
  NO_DOMAIN_ID,
  OPENCODE_SERVER_NAME,
  PROTOCOL_VERSION,
  PR_REVIEW_COMMENT_POSTED,
  SITE_SERVER_NAME,
  TRACING_SERVER_NAME,
  WORK_ITEMS_SERVER_NAME,
  auditRuntimePermissions,
  consoleLogger,
  ensureCoreBareUnset,
  ensureStateDir,
  generateSpanId,
  isCoreBareSet,
  loadManifest,
  options,
  parseLockfile,
  pruneExpiredCache,
  readCliConfig,
  readWorktreeConfig,
  resolveRealpath,
  resolveWorktreePath,
  sha256Hex,
  spawnCaptureSync,
  tryFlockExclusive,
} from "@mcp-cli/core";
import { AcpServer, buildAcpToolCache } from "./acp-server";
import { AliasServer, buildAliasToolCache } from "./alias-server";
import { AutomationDispatcher } from "./automation-dispatcher";
import { BudgetWatcher } from "./budget-watcher";
import { ClaudeServer, buildClaudeToolCache } from "./claude-server";
import { CodexServer, buildCodexToolCache } from "./codex-server";
import { configHash, loadConfig } from "./config/loader";
import { ConfigWatcher } from "./config/watcher";
import { closeDaemonLogFile, installDaemonLogCapture, installDaemonLogFile } from "./daemon-log";
import { adoptUnassignedDomains } from "./db/adopt-domains";
import { importLegacyState } from "./db/import-legacy";
import { StateDb } from "./db/state";
import { WorkItemDb } from "./db/work-items";
import { DerivedEventPublisher, migrateDerivedCursor } from "./derived-events";
import { DEFAULT_RULES } from "./derived-rules";
import { createDomainResolver, createStateDbDomainSource } from "./domain-resolver";
import { resolveDomainScope } from "./domain-scope";
import { DomainSupervisor } from "./domain-supervisor";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import type { CiEvent } from "./github/ci-events";
import { CopilotPoller } from "./github/copilot-poller";
import { type RepoInfo, detectRepo, resolveNumber } from "./github/graphql-client";
import { resolveBranchFromPr } from "./github/resolve-branch";
import { WorkItemPoller } from "./github/work-item-poller";
import { IpcServer } from "./ipc-server";
import { MailServer, buildMailToolCache } from "./mail-server";
import { metrics } from "./metrics";
import { MetricsServer } from "./metrics-server";
import { MockServer, buildMockToolCache } from "./mock-server";
import { MonitorRuntime } from "./monitor-runtime";
import { OpenCodeServer, buildOpenCodeToolCache } from "./opencode-server";
import { reapOrphanedSessions } from "./orphan-reaper";
import { QuotaPoller } from "./quota";
import { safeSetInterval, safeSetTimeout } from "./safe-timers";
import { ServerPool } from "./server-pool";
import { SessionMetricsAggregator } from "./session-metrics";
import { SiteServer, buildSiteToolCache } from "./site-server";
import { TracingServer } from "./tracing-server";
import { WorkItemsServer } from "./work-items-server";

/**
 * Acquire an exclusive flock on the PID file.
 *
 * Opens the PID file, acquires a non-blocking exclusive lock, and writes the PID data.
 * The fd is kept open for the daemon's lifetime — the kernel releases the lock
 * automatically on process death (even SIGKILL). No stale lock state.
 *
 * Returns the fd (caller must keep it open) or calls process.exit(1) if another
 * daemon holds the lock.
 */
export function acquirePidLock(logger: Logger): number {
  // Open without O_TRUNC — truncating before lock acquisition would zero out
  // a running daemon's PID file. Truncate only after the lock is held.
  const fd = openSync(options.PID_PATH, constants.O_WRONLY | constants.O_CREAT, 0o600);
  const acquired = tryFlockExclusive(fd);
  if (!acquired) {
    closeSync(fd);
    logger.error("[mcpd] Another daemon is already running (PID file locked)");
    process.exit(1);
  }
  // Now that we hold the lock, truncate to clear any previous content
  ftruncateSync(fd, 0);
  return fd;
}

/**
 * Write PID data to the already-locked PID file descriptor.
 */
function writePidData(fd: number, data: Record<string, unknown>): void {
  // Truncate before writing — if new JSON is shorter than previous content,
  // stale trailing bytes would corrupt the PID file.
  ftruncateSync(fd, 0);
  const buf = Buffer.from(JSON.stringify(data));
  writeSync(fd, buf, 0, buf.length, 0);
}

/** Git operations interface for dependency injection (testable without real git). */
export interface PruneGitOps {
  pathExists(path: string): boolean;
  status(worktreePath: string): { exitCode: number; stdout: string };
  showBranch(worktreePath: string): { exitCode: number; stdout: string };
  removeWorktree(repoRoot: string, worktreePath: string): { exitCode: number };
  deleteBranch(repoRoot: string, branch: string): { exitCode: number };
  exec(cmd: string[]): { stdout: string; exitCode: number };
}

/** Default git ops using spawnCaptureSync with cleaned environment. */
function defaultGitOps(): PruneGitOps {
  const cleanEnv = { ...process.env };
  for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX"]) {
    delete cleanEnv[k];
  }
  const run = (cmd: string[]) => {
    const first = cmd[0];
    if (!first) throw new Error("git cmd array must be non-empty");
    const r = spawnCaptureSync(first, cmd.slice(1), { env: cleanEnv });
    // exitCode null means the process was killed or failed to start — treat as failure (1)
    return { exitCode: r.exitCode !== null ? r.exitCode : 1, stdout: r.stdout.trim() };
  };
  return {
    pathExists: (p) => existsSync(p),
    status: (wt) => run(["git", "-C", wt, "status", "--porcelain"]),
    showBranch: (wt) => run(["git", "-C", wt, "branch", "--show-current"]),
    removeWorktree: (root, wt) => run(["git", "-C", root, "worktree", "remove", wt]),
    deleteBranch: (root, branch) => run(["git", "-C", root, "branch", "-d", branch]),
    exec: run,
  };
}

/**
 * Preflight: scan repo roots known to the daemon and remove the `core.bare`
 * config key entirely. An explicit `core.bare = false` is harmless but creates
 * a key that COULD be flipped to `true` by an unknown external operation.
 * Removing the key eliminates the attack surface. See #1860.
 *
 * Returns the number of repos where the key was removed.
 */
export function sweepCoreBare(
  db: StateDb,
  logger: Logger = consoleLogger,
  gitOps: PruneGitOps = defaultGitOps(),
): number {
  let healed = 0;
  try {
    const roots = new Set<string>();
    for (const s of db.listSessions(true)) {
      if (s.repoRoot) roots.add(s.repoRoot);
      else if (s.cwd) roots.add(s.cwd);
    }
    for (const s of db.listSessions(false)) {
      if (s.repoRoot) roots.add(s.repoRoot);
      else if (s.cwd) roots.add(s.cwd);
    }
    for (const root of roots) {
      const sweepResult = ensureCoreBareUnset(root, (cmd) => gitOps.exec(cmd));
      if (sweepResult === "removed") {
        logger.warn(`[mcpd] Removed core.bare key from ${root} (sweep) — see #1860`);
        metrics.counter("mcpd_core_bare_healed_total", { source: "sweep" }).inc();
        healed++;
      } else if (sweepResult === "fallback") {
        logger.warn(
          `[mcpd] core.bare key could not be removed from ${root} (sweep) — set to false as fallback — see #1860`,
        );
      }
    }
  } catch (err) {
    logger.error(`[mcpd] core.bare sweep failed: ${err}`);
  }
  return healed;
}

/** Remove worktrees from ended sessions that are clean and have no active session. */
export function pruneOrphanedWorktrees(
  db: StateDb,
  logger: Logger = consoleLogger,
  gitOps: PruneGitOps = defaultGitOps(),
): void {
  try {
    const activeSessions = db.listSessions(true);
    const activeWorktrees = new Set(
      activeSessions.filter((s) => s.worktree).map((s) => `${s.repoRoot ?? s.cwd}:${s.worktree}`),
    );

    const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const endedSessions = db
      .listSessions(false)
      .filter((s) => s.endedAt && Date.now() - new Date(s.endedAt).getTime() < RETENTION_MS);
    let pruned = 0;
    const affectedRepoRoots = new Set<string>();

    for (const session of endedSessions) {
      if (!session.worktree || !session.cwd) continue;
      const repoRoot = session.repoRoot ?? session.cwd;
      if (activeWorktrees.has(`${repoRoot}:${session.worktree}`)) continue;

      const hookConfig = readWorktreeConfig(repoRoot);
      const worktreePath = resolveWorktreePath(repoRoot, session.worktree, hookConfig);
      if (!gitOps.pathExists(worktreePath)) continue;

      // Check if clean
      const statusResult = gitOps.status(worktreePath);
      if (statusResult.exitCode !== 0 || statusResult.stdout.trim() !== "") continue;

      // Capture branch before removal
      const branchResult = gitOps.showBranch(worktreePath);
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

      // Remove worktree — instrument to detect which op flips core.bare (#1330).
      const bareBeforeRemove = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
      const removeResult = gitOps.removeWorktree(repoRoot, worktreePath);
      if (removeResult.exitCode === 0) {
        const bareAfterRemove = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
        if (!bareBeforeRemove && bareAfterRemove) {
          logger.warn(
            `[mcpd] core.bare flipped to true by: git worktree remove ${worktreePath} (repo=${repoRoot}) — see #1330`,
          );
        }
        const removeResult = ensureCoreBareUnset(repoRoot, (cmd) => gitOps.exec(cmd));
        if (removeResult === "removed") {
          logger.warn("[mcpd] Removed core.bare key after worktree removal");
          metrics.counter("mcpd_core_bare_healed_total", { source: "worktree_remove" }).inc();
        } else if (removeResult === "fallback") {
          logger.warn("[mcpd] core.bare key could not be removed after worktree removal — set to false as fallback");
        }
        affectedRepoRoots.add(repoRoot);
        pruned++;
        logger.info(`[mcpd] Pruned orphaned worktree: ${worktreePath}`);
        // Delete merged branch — also instrumented.
        if (branch) {
          const bareBeforeBranch = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
          const deleteResult = gitOps.deleteBranch(repoRoot, branch);
          if (deleteResult.exitCode === 0) {
            const bareAfterBranch = isCoreBareSet(repoRoot, (cmd) => gitOps.exec(cmd));
            if (!bareBeforeBranch && bareAfterBranch) {
              logger.warn(
                `[mcpd] core.bare flipped to true by: git branch -d ${branch} (repo=${repoRoot}) — see #1330`,
              );
              const branchDeleteResult = ensureCoreBareUnset(repoRoot, (cmd) => gitOps.exec(cmd));
              if (branchDeleteResult === "removed") {
                metrics.counter("mcpd_core_bare_healed_total", { source: "branch_delete" }).inc();
              } else if (branchDeleteResult === "fallback") {
                logger.warn("[mcpd] core.bare key could not be removed after branch delete — set to false as fallback");
              }
            }
            logger.info(`[mcpd] Deleted branch: ${branch} (merged)`);
          }
        }
      }
    }

    if (pruned > 0) {
      // Final guard: check core.bare after all removals complete. Individual
      // per-removal fixes can be undone by subsequent removals. #1206
      for (const root of affectedRepoRoots) {
        const batchResult = ensureCoreBareUnset(root, (cmd) => gitOps.exec(cmd));
        if (batchResult === "removed") {
          logger.warn("[mcpd] Removed core.bare key after batch worktree prune");
          metrics.counter("mcpd_core_bare_healed_total", { source: "worktree_remove" }).inc();
        } else if (batchResult === "fallback") {
          logger.warn(
            "[mcpd] core.bare key could not be removed after batch worktree prune — set to false as fallback",
          );
        }
      }
      logger.info(`[mcpd] Pruned ${pruned} orphaned worktree${pruned === 1 ? "" : "s"}`);
    }
  } catch (err) {
    logger.error(`[mcpd] Worktree prune failed: ${err}`);
  }
}

/** Per-phase timeout for shutdown steps (ms). Prevents any single phase from hanging the process. */
const SHUTDOWN_PHASE_TIMEOUT_MS = 5_000;

/**
 * Tighter timeout for `awaitPendingServers`. We don't actually need to wait
 * for in-flight virtual server startups during shutdown — abandoning them
 * is fine because the rest of the shutdown sequence tears down DB/IPC/pool
 * regardless. The previous 5s budget meant SIGTERM during a slow startup
 * (e.g. ws-server port retry) blocked exit by up to 5s. The new ws-server
 * retry schedule maxes out around 1.55s, so 2s gives normal startups room
 * to finish without making SIGTERM feel hung.
 */
const SHUTDOWN_PENDING_TIMEOUT_MS = 2_000;

/** Race a promise against a deadline. Returns "timeout" if the deadline is reached. */
async function withPhaseTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  logger: Logger,
): Promise<T | "timeout"> {
  const result = await Promise.race([
    promise.then((v) => ({ ok: v as T })),
    Bun.sleep(ms).then(() => ({ timeout: true as const })),
  ]);
  if ("timeout" in result) {
    logger.warn(`[mcpd] Shutdown phase "${label}" timed out after ${ms}ms — skipping`);
    return "timeout";
  }
  return result.ok;
}

export type ShutdownReason =
  | "SIGTERM"
  | "SIGINT"
  | "idle timeout"
  | "IPC shutdown request"
  | "uncaught exception"
  | "unhandled rejection";

/** Handle returned by startDaemon for testing and lifecycle management. */
export interface DaemonHandle {
  shutdown(reason?: ShutdownReason): Promise<void>;
  /** Resolves when shutdown completes. Useful for tests that need to await cleanup. */
  readonly shutdownComplete: Promise<void>;
  readonly isShuttingDown: boolean;
  readonly db: StateDb;
  readonly pool: ServerPool;
  readonly ipcServer: IpcServer;
  readonly watcher: ConfigWatcher;
}

export interface StartDaemonOptions {
  /** Skip log capture and log file setup (useful for tests). */
  skipLogSetup?: boolean;
  /** Skip booting virtual servers (_aliases, _claude). */
  skipVirtualServers?: boolean;
  /** Skip printing MCPD_READY to stdout (useful for tests). */
  skipReadySignal?: boolean;
  /** Logger for daemon output. Defaults to consoleLogger. */
  logger?: Logger;
  /** Override virtual servers used in the shutdown loop (test injection only). */
  _virtualServers?: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]>;
  /** Skip flock acquisition (useful for tests that don't need singleton enforcement). */
  skipFlock?: boolean;
}

/**
 * Verify SQLite >= 3.38 (required for unixepoch()). On macOS, bun:sqlite
 * dlopen's /usr/lib/libsqlite3.dylib — macOS 12 Monterey ships 3.37.0 which
 * lacks unixepoch(). Returns an error message string on failure, null on success.
 * See #2092.
 */
export function checkSqliteVersion(rawDb: import("bun:sqlite").Database): string | null {
  try {
    rawDb.query("SELECT unixepoch()").get();
    return null;
  } catch {
    let version = "unknown";
    try {
      version = (rawDb.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
    } catch {
      // ignore
    }
    const hint = process.platform === "darwin" ? " On macOS this means upgrading to 13 Ventura or later." : "";
    return `[mcpd] SQLite ${version} lacks unixepoch() — SQLite >= 3.38 is required.${hint}`;
  }
}

/**
 * Read .git/HEAD to resolve the current branch name for a given cwd.
 * Handles both regular repos and worktrees (where .git is a file
 * containing "gitdir: <path>"). Returns null for detached HEAD,
 * missing .git, or any FS error.
 */
export async function resolveHeadBranch(cwd: string): Promise<string | null> {
  try {
    const dotGitPath = `${cwd}/.git`;
    const dotGitStat = await fsStat(dotGitPath);
    let gitDir: string;
    if (dotGitStat.isFile()) {
      const gitdirLine = (await Bun.file(dotGitPath).text()).trim();
      const match = gitdirLine.match(/^gitdir:\s*(.+)$/);
      const target = match?.[1]?.trim();
      if (!target) return null;
      gitDir = isAbsolute(target) ? target : join(cwd, target);
    } else {
      gitDir = dotGitPath;
    }
    const headFile = Bun.file(`${gitDir}/HEAD`);
    if (!(await headFile.exists())) return null;
    const headContent = (await headFile.text()).trim();
    const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/);
    return refMatch?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the daemon and return a handle for lifecycle management.
 * Does not install process signal handlers or call process.exit — the caller is responsible.
 */
/**
 * Pick one row when a ring-0 lookup legitimately matched several domains.
 *
 * A PR/branch/issue number is unique **per domain**, so a cross-domain lookup can return
 * more than one row. Callers whose interface is single-valued take the first — but say so,
 * because a silently-chosen row is the ambiguity #3034 removed from the schema creeping back
 * in at the consumer. Per-domain dispatch removes the choice entirely (#3022).
 */
function firstOf<T extends { domainId: number }>(matches: T[], label: string, warn: (msg: string) => void): T | null {
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    warn(
      `[mcpd] ${label} matches ${matches.length} work items across domains (${matches
        .map((m) => m.domainId)
        .join(", ")}); acting on domain ${matches[0].domainId}. Per-domain dispatch is #3022.`,
    );
  }
  return matches[0];
}

export async function startDaemon(opts?: StartDaemonOptions): Promise<DaemonHandle> {
  // Allow env-based override for subprocess integration tests
  const skipVirtualServers = opts?.skipVirtualServers ?? process.env.MCP_DAEMON_SKIP_VIRTUAL_SERVERS === "1";
  const logger = opts?.logger ?? consoleLogger;

  // Cached repo info for resolveIssuePr — detected once from daemon startup cwd
  /**
   * PRE-EXISTING GAP, deliberately unchanged — see #3192.
   *
   * One repo, detected from the daemon's cwd. Wrong the moment two domains are two different
   * repos, and wrong before this PR too: the readers were unscoped then, so the poller has
   * always queried every tracked PR number against this one repo. Making the readers ring 0
   * restored that behaviour exactly rather than widening it, so #3037 neither caused nor owns
   * this. Per-domain pollers are #3022.
   */
  let cachedRepo: RepoInfo | null = null;

  if (!opts?.skipLogSetup) {
    installDaemonLogCapture();
    installDaemonLogFile();
  }

  // Ensure state directory exists with secure permissions (0700)
  ensureStateDir();

  // Load config
  const config = await loadConfig();
  const serverNames = [...config.servers.keys()];
  logger.info(`[mcpd] Loaded config: ${serverNames.length} servers (${serverNames.join(", ")})`);

  // Acquire exclusive flock on PID file — kernel-enforced singleton.
  // The lock is held for the daemon's lifetime (fd stays open).
  // On process death (even SIGKILL), the kernel releases it automatically.
  let pidFd: number | null = null;
  if (!opts?.skipFlock) {
    pidFd = acquirePidLock(logger);
  }

  // Generate daemon instance ID for trace context (stable for daemon lifetime)
  const daemonId = generateSpanId();

  // Write PID file (to the locked fd, or directly if flock is skipped)
  const startedAt = Date.now();
  const pidData = {
    pid: process.pid,
    daemonId,
    configHash: configHash(config),
    startedAt,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: BUILD_VERSION,
  };
  if (pidFd !== null) {
    writePidData(pidFd, pidData);
  } else {
    writeFileSync(options.PID_PATH, JSON.stringify(pidData));
  }

  // Preflight: verify SQLite >= 3.38 BEFORE opening StateDb — the constructor
  // runs migrations whose DEFAULT (unixepoch()) expressions would throw first
  // on macOS 12 Monterey (SQLite 3.37.0), swallowing the friendly error. See #2092.
  {
    const { Database } = await import("bun:sqlite");
    const rawDb = new Database(options.DB_PATH, { create: true });
    const sqliteError = checkSqliteVersion(rawDb);
    rawDb.close();
    if (sqliteError) {
      logger.error(sqliteError);
      throw new Error(sqliteError);
    }
  }

  // Open SQLite database
  const db = new StateDb(options.DB_PATH);
  logger.info(`[mcpd] Database: ${options.DB_PATH}`);

  // One-shot best-effort import from the pre-domain state.db (#3034). Runs before
  // anything else reads mcx.db so reapers and sweeps below see the imported rows.
  // The other schema consumers migrate first: their tables have to exist to be
  // imported into, and both are constructed again later (migrations are idempotent).
  new WorkItemDb(db.getDatabase());
  new EventLog(db.getDatabase());
  migrateDerivedCursor(db.getDatabase());
  // The import logs its own diagnostics — including the loud warning for "marker set but
  // mcx.db is empty", which is the one decline that means the daemon is booting without
  // the user's data. Route its sink at warn so that message cannot be swallowed by a log
  // level, and only whisper about the ordinary "nothing to import" case.
  const importResult = importLegacyState({ db: db.getDatabase(), log: (msg) => logger.warn(msg) });
  if (importResult.ran && !importResult.sealed) {
    logger.warn(
      `[mcpd] legacy import did not complete (${importResult.failedTables.length} table(s) failed) — it will retry on the next start`,
    );
  } else if (!importResult.ran) {
    logger.debug(`[mcpd] legacy import declined: ${importResult.reason}`);
  }

  // Adopt rows written before their domain existed. Runs on EVERY boot, not just the
  // one-shot import: scope sidecars become domain rows automatically at startup, so a box
  // that wrote `ctx.state` before that happened would otherwise find it silently absent
  // once a domain appeared — with no user action to blame and, until #3035 ships
  // `mcx domain rm`, no recovery short of raw sqlite3. Idempotent and cheap: adoption
  // only ever moves rows OFF the sentinel, so after the first boot the scan finds nothing.
  const adopted = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), (msg) => logger.warn(msg));
  if (adopted.stamped > 0) {
    logger.info(`[mcpd] adopted ${adopted.stamped} row(s) onto their domain`);
  }
  if (adopted.collided > 0) {
    logger.warn(
      `[mcpd] ${adopted.collided} row(s) stayed on the unassigned partition — their domain already holds those keys`,
    );
  }

  // Adopt pre-domain sessions into the domains that now exist (#3039). Separate from the
  // ADOPTABLE_TABLES sweep above — agent_sessions needs its own rules (skip ended rows,
  // one transaction, cwd-then-repo_root fallback order) that adoptUnassignedRows doesn't
  // model.
  //
  // ORDER IS LOAD-BEARING, in both directions, and `adoption-order.spec.ts` asserts it:
  //   - AFTER importLegacyState, because that is what copies `agent_sessions` in from
  //     the legacy db; adopting first finds nothing to adopt and every restored session
  //     stays at the sentinel, invisible to `-d` — the exact regression this fixes,
  //     reinstated silently.
  //   - BEFORE restoreActiveSessions below, so workers rebuild from corrected rows
  //     rather than from `domain_id = 0`, which they then hold in memory until the next
  //     restart.
  //
  // (An earlier version of this comment claimed adoption had to follow the import
  // because `importScopesAsDomains` creates domains before the `agent_sessions` copy so
  // `createDomain`'s own adopt hook could not catch those rows. That mechanism is
  // invented: `importScopesAsDomains` writes with a raw prepared INSERT on the attached
  // target and never calls `StateDb.createDomain`, so the hook was never in play. The
  // conclusion was right for the simpler reason above.)
  //
  // Best-effort, like the import directly above: it is idempotent and self-heals on the
  // next boot, so a SQLITE_BUSY must not take the daemon down with it.
  try {
    const adoptedSessions = db.adoptSessionsIntoDomains();
    if (adoptedSessions > 0) {
      logger.warn(`[mcpd] adopted ${adoptedSessions} pre-domain session(s) into their domains`);
    }
  } catch (err) {
    logger.warn(
      `[mcpd] adopting pre-domain sessions failed (retries next start): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Clean up DB records for sessions whose processes are dead.
  // Alive processes are preserved for restoreActiveSessions() to pick up.
  const cleaned = reapOrphanedSessions(db, logger);
  if (cleaned > 0) {
    logger.info(`[mcpd] Cleaned up ${cleaned} stale session(s) from previous run`);
  }

  // Prune expired alias cache entries
  const cachePruned = pruneExpiredCache();
  if (cachePruned > 0) {
    logger.info(`[mcpd] Pruned ${cachePruned} expired cache entry(ies)`);
  }

  // Warn if runtime state permissions have been loosened
  auditRuntimePermissions(logger);

  // Preflight: heal any core.bare=true drift on known repos before any
  // subsequent git op touches them. External tools like `gh pr merge
  // --delete-branch` can flip the bit outside our shim. See #1330.
  sweepCoreBare(db, logger);

  // Create server pool
  const pool = new ServerPool(config, db, undefined, logger);

  // Create virtual servers (started lazily after IPC socket is ready)
  const mailServer = new MailServer(db);
  const aliasServer = new AliasServer(db, daemonId);
  const cliConfig = readCliConfig();
  const wsPort = cliConfig.wsPort ?? DEFAULT_CLAUDE_WS_PORT;
  const claudeServer = new ClaudeServer(db, daemonId, undefined, logger, 10_000, wsPort);

  // Bun.which() is a synchronous builtin — no subprocess, no await needed.
  const [codexInstalled, ghInstalled, geminiInstalled, opencodeInstalled, grokInstalled] = [
    Bun.which("codex") !== null,
    Bun.which("gh") !== null,
    Bun.which("gemini") !== null,
    Bun.which("opencode") !== null,
    Bun.which("grok") !== null,
  ];

  // Codex server: only created if `codex` binary is installed
  const codexServer = codexInstalled ? new CodexServer(db, daemonId, undefined, logger) : null;

  // ACP server: created if any ACP-compatible agent binary is found on PATH
  // Includes Grok (via `grok agent stdio`) as a first-class target for sprint orchestration.
  const acpAgentInstalled = ghInstalled || geminiInstalled || grokInstalled;
  const acpServer = acpAgentInstalled ? new AcpServer(db, daemonId, undefined, logger) : null;

  // OpenCode server: only created if `opencode` binary is installed
  const opencodeServer = opencodeInstalled ? new OpenCodeServer(db, daemonId, undefined, logger) : null;

  // Mock server: always available (no external binary needed)
  const mockServer = new MockServer(db, daemonId, undefined, logger);

  // NDJSON protocol recording — enabled by MCX_RECORD_SESSION env var.
  // A single NdjsonRecorder instance is shared across all providers so
  // writes to the file are serialized (no interleaved partial lines).
  const recordingPath = process.env.MCX_RECORD_SESSION || null;
  let recorder: NdjsonRecorder | null = null;
  if (recordingPath) {
    recorder = new NdjsonRecorder(recordingPath);
    claudeServer.recorder = recorder;
    if (codexServer) codexServer.recorder = recorder;
    if (acpServer) acpServer.recorder = recorder;
    if (opencodeServer) opencodeServer.recorder = recorder;
    mockServer.recorder = recorder;
    logger.info(`[daemon] NDJSON protocol recording enabled → ${recordingPath}`);
  }

  // Site server: always started. The worker itself is lightweight — Playwright (and its ~200MB install)
  // is only loaded via dynamic import the first time a browser-dependent tool runs. Users with no
  // browser tool invocation pay the worker startup cost but nothing more.
  const siteServer = new SiteServer(daemonId, undefined, undefined, logger);

  // Domain workers: one per registered domain, spawned lazily on first use (see
  // domain-supervisor.ts for why lazy and not at startup). Nothing calls into a
  // domain worker until project execution moves there in #3044; what the daemon
  // owes it today is the reaping tick below and a clean stop at shutdown.
  const domainSupervisor = new DomainSupervisor({
    registry: db,
    daemonId,
    logger,
    onActivity: () => resetIdleTimer(),
  });

  // Start quota poller for proactive usage monitoring
  const quotaPoller = new QuotaPoller({ logger });
  quotaPoller.start();

  const metricsServer = new MetricsServer(metrics, quotaPoller, db);
  const tracingServer = new TracingServer(db);

  // Work items server: constructed lazily inside registerPendingVirtualServer
  // to keep migration errors from crashing the daemon (matches _metrics/_mail pattern).
  let workItemsServer: WorkItemsServer | null = null;
  let workItemPoller: WorkItemPoller | null = null;
  let copilotPoller: CopilotPoller | null = null;
  let derivedPublisher: DerivedEventPublisher | null = null;
  let monitorRuntime: MonitorRuntime | null = null;

  // Register uptime and server metrics
  const uptimeGauge = metrics.gauge("mcpd_uptime_seconds");
  const serversTotal = metrics.gauge("mcpd_servers_total");
  const serversConnected = metrics.gauge("mcpd_servers_connected");
  serversTotal.set(config.servers.size);

  // Periodically prune sessions whose processes have exited (every 30s).
  // This ensures dead sessions are cleaned up promptly, not just at idle-timeout boundary.
  // Also sweep core.bare so external flips (e.g. from `gh pr merge`) self-heal
  // within 30s regardless of origin. See #1330.
  const pruneInterval = safeSetInterval(() => {
    claudeServer.pruneDeadSessions();
    codexServer?.pruneDeadSessions();
    acpServer?.pruneDeadSessions();
    opencodeServer?.pruneDeadSessions();
    mockServer.pruneDeadSessions();
    sweepCoreBare(db, logger);
    // Reap workers whose domain row was removed or moved. Removal cannot be
    // lazy the way spawning is: nothing calls into a deleted domain, so nothing
    // would ever notice. Returns immediately when no worker is running.
    domainSupervisor.sync();
  }, 30_000);

  // Update uptime and server gauges periodically
  const metricsInterval = safeSetInterval(() => {
    uptimeGauge.set(Math.round(process.uptime()));
    const servers = pool.listServers();
    serversTotal.set(servers.length);
    serversConnected.set(servers.filter((s) => s.state === "connected").length);
  }, 5_000);

  // Idle timeout management with in-flight request tracking
  const idleTimeoutMs = Number(process.env.MCP_DAEMON_TIMEOUT) || DAEMON_IDLE_TIMEOUT_MS;
  let idleTimer: Timer | null = null;
  let inFlightCount = 0;

  let lastIdleReset = Date.now();
  /** Monotonic timestamp (ms) when the current idle timer was scheduled */
  let idleTimerScheduledAt = 0;

  function resetIdleTimer(): void {
    lastIdleReset = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimerScheduledAt = performance.now();
    const scheduledAt = idleTimerScheduledAt;
    idleTimer = safeSetTimeout(() => {
      const firedAt = performance.now();
      const actualDelayMs = Math.round(firedAt - scheduledAt);
      const driftMs = actualDelayMs - idleTimeoutMs;
      const sinceLast = Date.now() - lastIdleReset;
      logger.debug(
        `[mcpd] Idle timer fired: expected=${idleTimeoutMs}ms actual=${actualDelayMs}ms drift=${driftMs}ms (${Math.round(sinceLast / 1000)}s since last reset)`,
      );
      if (driftMs > 500) {
        logger.info(
          `[mcpd] Idle timer drift warning: ${driftMs}ms late (expected ${idleTimeoutMs}ms, actual ${actualDelayMs}ms)`,
        );
      }

      if (inFlightCount > 0) {
        logger.debug(`[mcpd] Idle timeout deferred: ${inFlightCount} request(s) in flight`);
        resetIdleTimer();
        return;
      }
      if (pool.hasPendingServers()) {
        logger.debug("[mcpd] Idle timeout deferred: virtual server(s) still starting");
        resetIdleTimer();
        return;
      }
      // Prune sessions whose processes have exited before checking
      claudeServer.pruneDeadSessions();
      codexServer?.pruneDeadSessions();
      acpServer?.pruneDeadSessions();
      opencodeServer?.pruneDeadSessions();
      mockServer.pruneDeadSessions();
      if (
        claudeServer.hasActiveSessions() ||
        codexServer?.hasActiveSessions() ||
        acpServer?.hasActiveSessions() ||
        opencodeServer?.hasActiveSessions() ||
        mockServer.hasActiveSessions()
      ) {
        logger.debug("[mcpd] Idle timeout deferred: session(s) not yet bye'd");
        resetIdleTimer();
        return;
      }
      logger.info("[mcpd] Idle timeout reached, shutting down");
      shutdown("idle timeout");
    }, idleTimeoutMs);
  }

  const eventLog = new EventLog(db.getDatabase());
  const seqBefore = eventLog.currentSeq();
  eventLog.startPruning();
  // One resolver for the whole daemon (#3040): the EventBus stamps every event with it
  // and the IPC server partitions alias_state with it, so "which domain owns this path"
  // has a single answer and a single memo to invalidate.
  // The daemon serves exactly one repo today — detected from its startup cwd. Named once
  // here so the several producers that need to state their domain all cite the same value
  // rather than each recomputing `resolve(process.cwd())` under a different name.
  // Epic B (domain servers) is what makes this per-domain rather than per-daemon.
  const daemonRepoRoot = resolveRealpath(resolve(process.cwd()));

  // One shared factory, not a hand-copy: the IPC server's fallback and the specs use the
  // same source, so the candidate order cannot drift between them (#3169 review R7).
  const domainResolver = createDomainResolver(createStateDbDomainSource(db));
  const mailEventBus = new EventBus(eventLog, Date.now, domainResolver);
  mailServer.setEventBus(mailEventBus);

  const restartedEvent = mailEventBus.publish({
    src: "daemon",
    event: DAEMON_RESTARTED,
    category: "daemon",
    seqBefore,
    seqAfter: seqBefore + 1,
    reason: "start",
  });
  logger.info(`[mcpd] Published daemon.restarted (seqBefore=${seqBefore}, seqAfter=${restartedEvent.seqAfter})`);

  // Watch config files for hot reload
  const watcher = new ConfigWatcher(config, (event) => {
    const { added, removed, changed } = pool.updateConfig(event.config);
    const changedKeys = [...added, ...removed, ...changed];
    const parts: string[] = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
    if (changed.length) parts.push(`changed: ${changed.join(", ")}`);
    if (parts.length) {
      logger.info(`[mcpd] Config reloaded: ${parts.join("; ")}`);
    } else {
      logger.info("[mcpd] Config reloaded (no server changes)");
    }
    if (changedKeys.length > 0) {
      mailEventBus.publish({
        src: "daemon",
        event: DAEMON_CONFIG_RELOADED,
        category: "daemon",
        changedKeys,
      });
    }
    // Update PID file with new hash (use locked fd if available)
    const updatedPid = {
      pid: process.pid,
      daemonId,
      configHash: event.hash,
      startedAt,
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: BUILD_VERSION,
    };
    if (pidFd !== null) {
      writePidData(pidFd, updatedPid);
    } else {
      writeFileSync(options.PID_PATH, JSON.stringify(updatedPid));
    }
  });
  watcher.start();

  // Budget watcher: emits cost/quota threshold events (#1587)
  // mailEventBus + eventLog are already created on origin/main earlier in this function (#1586).
  const budgetWatcher = new BudgetWatcher({ bus: mailEventBus, db, quotaPoller, eventLog });
  const budgetReconciled = budgetWatcher.reconcile();
  if (budgetReconciled > 0) {
    logger.info(`[mcpd] Budget watcher reconciliation replayed ${budgetReconciled} event(s)`);
  }

  // Session metrics aggregator (#1610) — on by default, opt-out via config
  let sessionMetricsAgg: SessionMetricsAggregator | null = null;
  const cliCfg = readCliConfig();
  if (cliCfg.metrics?.session?.enabled !== false) {
    sessionMetricsAgg = new SessionMetricsAggregator({
      bus: mailEventBus,
      db: db.database,
    });
    logger.info("[mcpd] Session metrics aggregator started");
  }

  // Start automation dispatcher (#2018) — reads lockfile, subscribes to event bus
  let automationDispatcher: AutomationDispatcher | null = null;
  {
    // Ring 0: the dispatcher's work-item lookups span every domain. It must not be bound to
    // "the daemon's domain" — mcpd is auto-started by whichever mcx call needed it, sometimes
    // with no cwd, so a startup-time binding partitions it by process ancestry (see
    // WorkItemDb.acrossDomains).
    const workItemDb = new WorkItemDb(db.getDatabase()).acrossDomains();
    // KNOWN GAP, not an oversight: the automation manifest and its lockfile are still read
    // from the daemon's cwd, so which project's automation runs depends on where mcpd was
    // started. This is the same class of defect the ring-0 change above removes from the
    // work-item readers, but it cannot be fixed the same way: automation is inherently
    // per-project, so the fix is one dispatcher per domain (epic B / #3022), not one
    // dispatcher reading across domains. Tracked separately; deliberately NOT bundled into
    // #3037. The startup log below names the root it bound to so the choice is visible
    // rather than implied.
    let manifestResult: ReturnType<typeof loadManifest> | null = null;
    try {
      manifestResult = loadManifest(process.cwd());
    } catch (err) {
      if (err instanceof ManifestVersionError) {
        logger.warn(`[mcpd] ${err.message}`);
      } else {
        logger.warn(`[mcpd] Failed to load manifest for automation: ${err} — skipping`);
      }
    }
    if (manifestResult?.manifest?.automation) {
      const lockfilePath = join(process.cwd(), LOCKFILE_NAME);
      let automations: import("@mcp-cli/core").LockedAutomation[] = [];
      try {
        const lockText = readFileSync(lockfilePath, "utf-8");
        const lock = parseLockfile(lockText);
        const currentManifestHash = sha256Hex(readFileSync(manifestResult.path, "utf-8"));
        if (lock.manifestHash !== currentManifestHash) {
          logger.warn(
            `[mcpd] Lockfile manifest hash mismatch (locked: ${lock.manifestHash.slice(0, 8)}… vs current: ${currentManifestHash.slice(0, 8)}…) — run \`mcx phase install\``,
          );
        }
        automations = lock.automations ?? [];
      } catch (err) {
        const isEnoent = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
        if (isEnoent) {
          logger.warn("[mcpd] Automation configured but no lockfile found — run `mcx phase install`");
        } else {
          logger.warn(
            `[mcpd] Automation configured but lockfile is corrupt: ${err instanceof Error ? err.message : String(err)} — run \`mcx phase install\``,
          );
        }
      }
      // PRE-EXISTING GAP, deliberately left exactly as it was — see #3192.
      //
      // Phase state is keyed by (repo_root, namespace, key), and this root is the daemon's
      // cwd. That is already the wrong key when the daemon starts outside the project, and it
      // was wrong before this PR too. #3037 does NOT own it: nothing about scoping work_items
      // by domain requires deriving a phase-state root.
      //
      // An earlier round of this PR tried to fix it here by substituting the domain's
      // registered path. That was worse — `mcx scope add` stores a cwd with no git-root check
      // and a domain may legally be registered at an ANCESTOR of the repo, so the registered
      // path and the git root every writer uses coincide only by luck. It replaced a known
      // stale key with a differently-wrong one and made this file the fifth independent
      // derivation of a key that already had four. Reverted rather than patched.
      const automationRepoRoot = resolveRealpath(resolve(process.cwd()));
      if (automations.length > 0) {
        automationDispatcher = new AutomationDispatcher({
          eventBus: mailEventBus,
          repoRoot: automationRepoRoot,
          getWorkItemOverrides: (workItemId) => {
            const item = workItemDb.getWorkItem(workItemId);
            return item?.automationOverrides ?? undefined;
          },
          // The dispatcher's callbacks are single-valued, but a PR/branch/issue number can
          // name one item per domain. Take the first and SAY SO when there are more, rather
          // than silently picking one — this restores the pre-#3037 behaviour (these reads
          // were unscoped) while making the ambiguity visible instead of implicit. Per-domain
          // dispatch is #3022.
          resolveWorkItemId: (prNumber) => firstOf(workItemDb.findByPr(prNumber), `PR #${prNumber}`, logger.warn)?.id,
          getWorkItemByBranch: (branch) => firstOf(workItemDb.findByBranch(branch), `branch ${branch}`, logger.warn),
          getWorkItemByIssue: (issueNumber) =>
            firstOf(workItemDb.findByIssue(issueNumber), `issue #${issueNumber}`, logger.warn),
          updateWorkItem: (id, patch) => {
            const item = workItemDb.getWorkItem(id);
            if (!item) return;
            // Write into the row's OWN partition, not a partition the daemon guessed.
            workItemDb.forRow(item).updateWorkItem(id, patch as import("@mcp-cli/core").WorkItemPatch);
          },
          getWorkItem: (workItemId) => {
            const item = workItemDb.getWorkItem(workItemId);
            if (!item) return null;
            return {
              id: item.id,
              domainId: item.domainId,
              issueNumber: item.issueNumber,
              prNumber: item.prNumber,
              branch: item.branch,
              phase: item.phase,
            };
          },
          getWorkItemState: (workItemId) => {
            // Automation state lives in alias_state under `workitem:<id>` — the same
            // rows `ctx.state` writes from a phase script, so it must be read from the
            // same partition or a module would see an empty snapshot for a work item
            // whose phase script had just written to it (#3040). `workItemId` here is
            // always the canonical id straight off a DB row (see `resolveWorkItemId` /
            // `resolveWorkItemIdFromEvent` above) — never a caller-typed spelling — so
            // `workItemStateNamespace` is safe to use directly (#3037).
            return db.listAliasState(
              automationRepoRoot,
              workItemStateNamespace(workItemId),
              domainResolver.idForPath(automationRepoRoot),
            );
          },
          actionExecutor: {
            async byeAndUntrack(workItemId, sessionIds) {
              const byeResults = await Promise.allSettled(
                sessionIds.map(async (sid) => {
                  try {
                    await pool.callTool(CLAUDE_SERVER_NAME, "claude_bye", {
                      sessionId: sid,
                      message: "automation cleanup: PR merged",
                    });
                  } catch (err) {
                    logger.warn(
                      `[automation] claude_bye failed for ${sid}: ${err instanceof Error ? err.message : String(err)} — ending in DB`,
                    );
                    db.endSession(sid);
                  }
                }),
              );
              for (let i = 0; i < byeResults.length; i++) {
                if (byeResults[i].status === "rejected") {
                  logger.warn(`[automation] failed to end session ${sessionIds[i]}`);
                }
              }
              const owning = workItemDb.getWorkItem(workItemId);
              if (owning) {
                const rowScoped = workItemDb.forRow(owning);
                try {
                  rowScoped.updateWorkItem(workItemId, { phase: "done" });
                } catch {
                  logger.warn(`[automation] failed to set phase=done on ${workItemId}`);
                }
                try {
                  rowScoped.deleteWorkItem(workItemId);
                } catch {
                  logger.warn(`[automation] failed to untrack ${workItemId}`);
                }
              }
            },
          },
        });
        automationDispatcher.load(manifestResult.manifest.automation, automations);
        automationDispatcher.start();
        logger.info(
          `[mcpd] Automation dispatcher started (${automations.length} module(s), preset: ${manifestResult.manifest.automation.preset ?? "supervised"}) — manifest root ${automationRepoRoot} (from daemon cwd; per-domain dispatch is #3022)`,
        );
      }
    }
  }

  // Start IPC server
  const ipcServer = new IpcServer(pool, config, db, aliasServer, {
    daemonId,
    startedAt,
    onActivity: () => {
      inFlightCount++;
      resetIdleTimer();
    },
    onRequestComplete: () => {
      inFlightCount = Math.max(0, inFlightCount - 1);
      resetIdleTimer();
    },
    onShutdown: () => shutdown("IPC shutdown request"),
    onReloadConfig: () => watcher.forceReload(),
    logger,
    getWsPortInfo: () => ({ actual: claudeServer.port, expected: wsPort }),
    getQuotaStatus: () => {
      const status = quotaPoller.status;
      return {
        fiveHour: status?.fiveHour ?? null,
        sevenDay: status?.sevenDay ?? null,
        sevenDaySonnet: status?.sevenDaySonnet ?? null,
        sevenDayOpus: status?.sevenDayOpus ?? null,
        extraUsage: status?.extraUsage ?? null,
        fetchedAt: status?.fetchedAt ?? 0,
        lastError: quotaPoller.lastError,
      };
    },
    resolveIssuePr: async (number: number) => {
      // Cache repo detection so we don't re-run `git remote` on every track call.
      // Uses the daemon's startup cwd which is the project root at launch time (#3192).
      if (!cachedRepo) {
        cachedRepo = await detectRepo(process.cwd());
      }
      const resolved = await resolveNumber(cachedRepo, number);
      return { prNumber: resolved.prNumber };
    },
    eventBus: mailEventBus,
    onAliasChanged: (name) => {
      monitorRuntime?.restartMonitor(name).catch((err) => {
        logger.error(`[mcpd] Monitor restart for "${name}" failed: ${err}`);
      });
    },
    automationDispatcher: automationDispatcher ?? undefined,
    domains: domainResolver,
  });
  await ipcServer.start();

  // Reset idle timer on Claude/Codex/ACP session worker events (db:upsert, db:state, db:cost)
  claudeServer.onActivity = () => resetIdleTimer();
  // Work-item and CI events from the daemon's own pollers carry only a prNumber/branch:
  // `work_items` has no repo column and no domain_id writer yet (#3036/#3037), so there
  // is nothing on the event to resolve. The daemon polls exactly one repo, so it declares
  // that root here rather than leaving ~19% of the traffic un-domained (#3040 review R3).
  // A producer that already said which repo it means is left alone.
  claudeServer.onMonitorEvent = (input) =>
    mailEventBus.publish(
      input.repoRoot === undefined &&
        input.sessionId === undefined &&
        (input.category === "work_item" || input.category === "ci")
        ? { ...input, repoRoot: daemonRepoRoot }
        : input,
    );
  if (codexServer) {
    codexServer.onActivity = () => resetIdleTimer();
  }
  if (acpServer) {
    acpServer.onActivity = () => resetIdleTimer();
  }
  if (opencodeServer) {
    opencodeServer.onActivity = () => resetIdleTimer();
  }
  mockServer.onActivity = () => resetIdleTimer();
  // Site browser sessions can sit idle during interactive login — keep the daemon alive.
  siteServer.onActivity = () => resetIdleTimer();

  // Every agent provider drops the resolver's memo for a session it just wrote, so a row
  // that gains a repo_root after its first event is re-resolved instead of keeping the
  // domain it was first observed in (#3169 review). Iterated rather than assigned four
  // times so adding a fifth provider is one list entry, not a forgotten line.
  //
  // Excludes siteServer (browser sessions, not agent sessions) and mockServer (a test
  // double); neither extends AbstractWorkerServer, so neither has the hook.
  for (const server of [claudeServer, codexServer, acpServer, opencodeServer]) {
    if (server) server.onSessionUpserted = (sessionId: string) => domainResolver.invalidateSession(sessionId);
  }

  // Start idle timer
  resetIdleTimer();
  logger.debug(
    `[mcpd] Idle timer started ${Math.round(performance.now())}ms after process start (timeout=${idleTimeoutMs}ms)`,
  );

  // Signal readiness to parent (IPC socket is open, commands can connect now).
  // Uses console.log (stdout) because installDaemonLogCapture redirects
  // console.info/error/warn to stderr — the parent process reads stdout.
  // Tests pass skipReadySignal to suppress this output.
  if (!opts?.skipReadySignal) {
    console.log(DAEMON_READY_SIGNAL);
  }

  // Boot virtual servers in the background — commands that need them will await
  if (!skipVirtualServers) {
    pool.registerPendingVirtualServer(
      ALIAS_SERVER_NAME,
      (async () => {
        try {
          const { client, transport } = await aliasServer.start();
          const cachedTools = buildAliasToolCache(db);
          pool.registerVirtualServer(ALIAS_SERVER_NAME, client, transport, cachedTools);
          logger.info(`[mcpd] Alias server started (${cachedTools.size} tools)`);

          // Start monitor runtime for defineMonitor aliases
          monitorRuntime = new MonitorRuntime({
            bus: mailEventBus,
            logger,
            listMonitors: () => db.listAliases().filter((a) => a.aliasType === "defineMonitor"),
            getAlias: (name) => {
              const a = db.getAlias(name);
              if (!a) return undefined;
              return { ...a, aliasType: a.aliasType };
            },
          });
          await monitorRuntime.startAll();
        } catch (err) {
          logger.error(`[mcpd] Failed to start alias server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      CLAUDE_SERVER_NAME,
      (async () => {
        try {
          const { client: claudeClient, transport: claudeTransport } = await claudeServer.start();
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer(CLAUDE_SERVER_NAME, claudeClient, claudeTransport, claudeTools);
          logger.info(`[mcpd] Claude session server started (port ${claudeServer.port})`);
        } catch (err) {
          logger.error(`[mcpd] Failed to start Claude session server: ${err}`);
        }

        // Re-register _claude virtual server after crash recovery
        claudeServer.onRestarted = (client, transport) => {
          const claudeTools = buildClaudeToolCache();
          pool.registerVirtualServer(CLAUDE_SERVER_NAME, client, transport, claudeTools);
          logger.info(`[mcpd] Claude session server re-registered after crash recovery (port ${claudeServer.port})`);
        };
      })(),
    );

    if (codexServer) {
      pool.registerPendingVirtualServer(
        CODEX_SERVER_NAME,
        (async () => {
          try {
            const { client: codexClient, transport: codexTransport } = await codexServer.start();
            const codexTools = buildCodexToolCache();
            pool.registerVirtualServer(CODEX_SERVER_NAME, codexClient, codexTransport, codexTools);
            logger.info("[mcpd] Codex session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start Codex session server: ${err}`);
          }

          codexServer.onRestarted = (client, transport) => {
            const codexTools = buildCodexToolCache();
            pool.registerVirtualServer(CODEX_SERVER_NAME, client, transport, codexTools);
            logger.info("[mcpd] Codex session server re-registered after crash recovery");
          };
        })(),
      );
    }

    if (acpServer) {
      pool.registerPendingVirtualServer(
        ACP_SERVER_NAME,
        (async () => {
          try {
            const { client: acpClient, transport: acpTransport } = await acpServer.start();
            const acpTools = buildAcpToolCache();
            pool.registerVirtualServer(ACP_SERVER_NAME, acpClient, acpTransport, acpTools);
            logger.info("[mcpd] ACP session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start ACP session server: ${err}`);
          }

          acpServer.onRestarted = (client, transport) => {
            const acpTools = buildAcpToolCache();
            pool.registerVirtualServer(ACP_SERVER_NAME, client, transport, acpTools);
            logger.info("[mcpd] ACP session server re-registered after crash recovery");
          };
        })(),
      );
    }

    if (opencodeServer) {
      pool.registerPendingVirtualServer(
        OPENCODE_SERVER_NAME,
        (async () => {
          try {
            const { client: opencodeClient, transport: opencodeTransport } = await opencodeServer.start();
            const opencodeTools = buildOpenCodeToolCache();
            pool.registerVirtualServer(OPENCODE_SERVER_NAME, opencodeClient, opencodeTransport, opencodeTools);
            logger.info("[mcpd] OpenCode session server started");
          } catch (err) {
            logger.error(`[mcpd] Failed to start OpenCode session server: ${err}`);
          }

          opencodeServer.onRestarted = (client, transport) => {
            const opencodeTools = buildOpenCodeToolCache();
            pool.registerVirtualServer(OPENCODE_SERVER_NAME, client, transport, opencodeTools);
            logger.info("[mcpd] OpenCode session server re-registered after crash recovery");
          };
        })(),
      );
    }

    pool.registerPendingVirtualServer(
      MOCK_SERVER_NAME,
      (async () => {
        try {
          const { client: mockClient, transport: mockTransport } = await mockServer.start();
          const mockTools = buildMockToolCache();
          pool.registerVirtualServer(MOCK_SERVER_NAME, mockClient, mockTransport, mockTools);
          logger.info("[mcpd] Mock session server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start mock server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      SITE_SERVER_NAME,
      (async () => {
        try {
          const { client: siteClient, transport: siteTransport } = await siteServer.start();
          const siteTools = buildSiteToolCache();
          pool.registerVirtualServer(SITE_SERVER_NAME, siteClient, siteTransport, siteTools);
          logger.info("[mcpd] Site server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start site server: ${err}`);
        }

        siteServer.onRestarted = (client, transport) => {
          const siteTools = buildSiteToolCache();
          pool.registerVirtualServer(SITE_SERVER_NAME, client, transport, siteTools);
          logger.info("[mcpd] Site server re-registered after crash recovery");
        };
        siteServer.onPermanentlyFailed = () => {
          pool.unregisterVirtualServer(SITE_SERVER_NAME);
          logger.error("[mcpd] Site server permanently failed — removed from pool; restart daemon to recover");
        };
      })(),
    );

    pool.registerPendingVirtualServer(
      METRICS_SERVER_NAME,
      (async () => {
        try {
          const {
            client: metricsClient,
            transport: metricsTransport,
            tools: metricsTools,
          } = await metricsServer.start();
          pool.registerVirtualServer(METRICS_SERVER_NAME, metricsClient, metricsTransport, metricsTools);
          logger.info("[mcpd] Metrics server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start metrics server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      TRACING_SERVER_NAME,
      (async () => {
        try {
          const {
            client: tracingClient,
            transport: tracingTransport,
            tools: tracingTools,
          } = await tracingServer.start();
          pool.registerVirtualServer(TRACING_SERVER_NAME, tracingClient, tracingTransport, tracingTools);
          logger.info("[mcpd] Tracing server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start tracing server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      MAIL_SERVER_NAME,
      (async () => {
        try {
          const { client: mailClient, transport: mailTransport, tools: mailTools } = await mailServer.start();
          pool.registerVirtualServer(MAIL_SERVER_NAME, mailClient, mailTransport, mailTools);
          logger.info("[mcpd] Mail server started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start mail server: ${err}`);
        }
      })(),
    );

    pool.registerPendingVirtualServer(
      WORK_ITEMS_SERVER_NAME,
      (async () => {
        try {
          const workItems = new WorkItemDb(db.database);
          // Ring 0 (see WorkItemDb.acrossDomains): the pollers, derived events and
          // ctx.workItem resolution are daemon-internal machinery and read EVERY domain.
          // They used to bind to resolveDomainScope(db, process.cwd()) here, which meant the
          // daemon read whichever partition it happened to wake up in while every writer
          // scoped per request — so listWorkItems() returned [] and PR state, CI events and
          // automation silently stopped for every tracked item.
          //
          // The MCP server below is deliberately NOT ring 0: it is a caller-facing surface
          // and scopes per call, from the caller's cwd.
          const workItemDb = workItems.acrossDomains();

          /**
           * Domain name for a work-item event, resolved PER EVENT from the row it concerns.
           *
           * Previously a single name captured at startup from the daemon's cwd, which was
           * wrong for every item outside that partition — and the daemon has no cwd of its
           * own worth trusting. `null` when the item is unassigned or unknown; never a guess.
           */
          const domainNameFor = (event: import("@mcp-cli/core").WorkItemEvent): string | null => {
            const item =
              "itemId" in event
                ? workItemDb.getWorkItem(event.itemId)
                : "prNumber" in event
                  ? firstOf(workItemDb.findByPr(event.prNumber), `PR #${event.prNumber}`, logger.warn)
                  : null;
            if (!item || item.domainId === NO_DOMAIN_ID) return null;
            return db.getDomainById(item.domainId)?.name ?? null;
          };

          // Create the poller first so we can pass pollNow to the server
          workItemPoller = new WorkItemPoller({
            db: workItemDb,
            logger,
            onEvent: (event) => claudeServer.forwardWorkItemEvent(event, domainNameFor(event)),
            onCiEvent: (event) => publishCiEvent(mailEventBus, event),
          });

          // Wire the alias executor's work-item resolver — resolves the caller
          // cwd's branch → tracked work item in-process, so alias subprocesses
          // don't need to phone home via IPC to answer ctx.workItem.
          // ctx.domain for phases and aliases executed in the daemon (#3037).
          aliasServer.setDomainResolver((cwd) => {
            const resolved = resolveDomainScope(db, cwd);
            return resolved.id === NO_DOMAIN_ID ? null : { id: resolved.id, name: resolved.name };
          });

          aliasServer.setWorkItemResolver(async (cwd) => {
            try {
              const RESOLVE_TIMEOUT_MS = 500;
              const resolved = await Promise.race([
                resolveHeadBranch(cwd),
                Bun.sleep(RESOLVE_TIMEOUT_MS).then(() => null),
              ]);
              if (!resolved) return null;
              const item = firstOf(workItemDb.findByBranch(resolved), `branch ${resolved}`, logger.warn);
              if (!item) return null;
              return {
                id: item.id,
                domainId: item.domainId,
                issueNumber: item.issueNumber,
                prNumber: item.prNumber,
                branch: item.branch,
                phase: item.phase,
              };
            } catch (err) {
              logger.debug(
                `[mcpd] workItemResolver failed for cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            }
          });

          workItemsServer = new WorkItemsServer(workItems, {
            // Bundled with the resolver so `_work_items` phase_state_* partitions on the
            // same domain `ctx.state` does. These were split-brain until #3040 review R1.
            phaseState: { store: db, domainIdFor: (repoRoot) => domainResolver.idForPath(repoRoot) },
            onTrack: () => workItemPoller?.pollNow(),
            loadManifest: (repoRoot) => {
              try {
                return loadManifest(repoRoot)?.manifest ?? null;
              } catch (err) {
                if (err instanceof ManifestVersionError) throw err;
                // Malformed manifest — behave as if absent so callers don't hard-fail.
                return null;
              }
            },
            resolveBranchFromPr: async (prNumber: number) => {
              // Re-use the cached repo (see #3192) so the --repo flag is always explicit,
              // avoiding `gh pr view` resolving against an ambiguous cwd. Returns null when
              // detection fails; the caller treats that as "branch not known" and continues.
              if (!cachedRepo) {
                try {
                  cachedRepo = await detectRepo(process.cwd());
                } catch {
                  return null;
                }
              }
              return resolveBranchFromPr(prNumber, { repo: cachedRepo });
            },
            logger,
          });
          const {
            client: workItemsClient,
            transport: workItemsTransport,
            tools: workItemsTools,
          } = await workItemsServer.start();
          pool.registerVirtualServer(WORK_ITEMS_SERVER_NAME, workItemsClient, workItemsTransport, workItemsTools);
          logger.info("[mcpd] Work items server started");

          // Start the GitHub work item poller — forwards events to the claude session worker
          // so `mcx wait --any` / `--pr` / `--checks` can race work item events.
          workItemPoller.start();
          logger.info("[mcpd] Work item poller started");

          copilotPoller = new CopilotPoller({
            workItemDb,
            stateDb: db,
            logger,
            onEvent: (rawEvent) => {
              // Same reasoning as the work-item poller: these are repo-scoped events
              // (review, issue, PR comments) from a poller bound to the daemon's one
              // repo, and they key only on prNumber — so the producer states its root
              // rather than publishing un-domained (#3040 review R3).
              // Only when the event names no other identity. Note the bus's order is
              // preference, not strict precedence — an unresolvable repoRoot falls through
              // to the session — but stamping the daemon's root onto a session-bearing
              // event would still win whenever that root DOES resolve, which would
              // attribute another domain's session to this one.
              const event =
                rawEvent.repoRoot === undefined && rawEvent.sessionId === undefined
                  ? { ...rawEvent, repoRoot: daemonRepoRoot }
                  : rawEvent;
              if (event.event === PR_REVIEW_COMMENT_POSTED) {
                const key = `${event.event}:${event.prNumber}:${event.author}`;
                mailEventBus.publishCoalesced(event, key, {
                  mode: "merge",
                  merge: (a, b) => {
                    const ids = [
                      ...new Set([...((a.commentIds as number[]) ?? []), ...((b.commentIds as number[]) ?? [])]),
                    ];
                    return { ...a, newCount: ids.length, commentIds: ids };
                  },
                  windowMs: 500,
                });
              } else {
                mailEventBus.publish(event);
              }
            },
          });
          copilotPoller.start();
          logger.info("[mcpd] Copilot poller started");

          // Derived event publisher: subscribes to the bus AFTER poller is up,
          // runs rules on each event, re-publishes derived events with causedBy chain.
          // Subscribe order: subscribers registered before this (SSE streams) see
          // trigger events before derived events; subscribers registered after see
          // derived events first (both carry seq for canonical ordering).
          derivedPublisher = new DerivedEventPublisher({
            bus: mailEventBus,
            rules: DEFAULT_RULES,
            workItemDb,
            db: db.database,
            eventLog,
          });
          const reconciled = derivedPublisher.reconcile();
          if (reconciled > 0) {
            logger.info(`[mcpd] Derived event reconciliation replayed ${reconciled} event(s)`);
          }
          logger.info("[mcpd] Derived event publisher started");
        } catch (err) {
          logger.error(`[mcpd] Failed to start work items server: ${err}`);
        }
      })(),
    );
  }

  function publishCiEvent(bus: EventBus, event: CiEvent): void {
    const base = {
      src: "daemon.work-item-poller",
      event: event.type,
      category: "ci" as const,
      prNumber: event.prNumber,
      workItemId: event.workItemId,
      // The producer states its own domain rather than leaving it to be inferred
      // (#3040 review R3). CI events key only on prNumber/workItemId, and `work_items`
      // has no repo column or domain_id writer yet (#3036/#3037) — so until it does,
      // the daemon's own root is the honest answer: this poller polls exactly one repo,
      // detected from the daemon's cwd at startup.
      repoRoot: daemonRepoRoot,
    };
    const coalesceKey = `ci:${event.prNumber}`;

    if (event.type === "ci.started") {
      bus.publish({ ...base, checks: event.checks });
    } else if (event.type === "ci.running") {
      bus.publishCoalesced({ ...base, inProgress: event.inProgress, completed: event.completed }, coalesceKey, {
        mode: "last-wins",
        windowMs: 500,
      });
    } else {
      // ci.finished — flush pending ci.running, then publish immediately
      bus.publishCoalesced(
        { ...base, checks: event.checks, allGreen: event.allGreen, observedDurationMs: event.observedDurationMs },
        coalesceKey,
        { mode: "never" },
      );
    }
  }

  // Graceful shutdown — re-entrant safe
  let _isShuttingDown = false;
  let _resolveShutdown!: () => void;
  const _shutdownComplete = new Promise<void>((r) => {
    _resolveShutdown = r;
  });
  async function shutdown(reason?: ShutdownReason): Promise<void> {
    if (_isShuttingDown) return;
    _isShuttingDown = true;
    const shutdownStart = performance.now();
    try {
      logger.info(`[mcpd] Shutting down${reason ? ` (${reason})` : ""}...`);
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(pruneInterval);
      clearInterval(metricsInterval);
      automationDispatcher?.stop();
      eventLog.stopPruning();
      quotaPoller.stop();
      budgetWatcher.dispose();
      workItemPoller?.stop();
      copilotPoller?.stop();
      derivedPublisher?.dispose();
      sessionMetricsAgg?.dispose();
      if (monitorRuntime) {
        const monPhase = performance.now();
        await withPhaseTimeout(monitorRuntime.stopAll(), SHUTDOWN_PHASE_TIMEOUT_MS, "monitorRuntime.stopAll", logger);
        logger.info(`[mcpd] Shutdown: monitorRuntime.stopAll took ${Math.round(performance.now() - monPhase)}ms`);
      }
      mailEventBus.disposeCoalescer();
      try {
        watcher.stop();
      } catch (err) {
        logger.error(`[mcpd] Error stopping config watcher: ${err}`);
      }
      try {
        ipcServer.stop();
      } catch (err) {
        logger.error(`[mcpd] Error stopping IPC server: ${err}`);
      }
      // Wait briefly for any in-progress virtual server startups before stopping
      // them. Don't block shutdown on slow startups — the subsequent
      // server.stop() calls handle the in-flight case, and dropping the wait
      // means SIGTERM exits promptly even if a worker is mid-port-retry.
      let phase = performance.now();
      try {
        await withPhaseTimeout(pool.awaitPendingServers(), SHUTDOWN_PENDING_TIMEOUT_MS, "awaitPendingServers", logger);
      } catch (err) {
        logger.error(`[mcpd] Error awaiting pending servers: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: awaitPendingServers took ${Math.round(performance.now() - phase)}ms`);
      // Domain workers are supervised outside the pool (they are not virtual MCP
      // servers — nothing routes tool calls to them by name), so they get their
      // own bounded stop. Every worker is stopped even if one hangs.
      phase = performance.now();
      try {
        await withPhaseTimeout(domainSupervisor.stopAll(), SHUTDOWN_PHASE_TIMEOUT_MS, "stop domain workers", logger);
      } catch (err) {
        logger.error(`[mcpd] Error stopping domain workers: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: stop domain workers took ${Math.round(performance.now() - phase)}ms`);
      // Stop each virtual server individually so one failure doesn't leak the rest
      const virtualServers: ReadonlyArray<readonly [string, { stop(): Promise<void> } | null]> =
        opts?._virtualServers ?? [
          [CLAUDE_SERVER_NAME, claudeServer],
          [CODEX_SERVER_NAME, codexServer],
          [ACP_SERVER_NAME, acpServer],
          [OPENCODE_SERVER_NAME, opencodeServer],
          [MOCK_SERVER_NAME, mockServer],
          [SITE_SERVER_NAME, siteServer],
          [ALIAS_SERVER_NAME, aliasServer],
          [METRICS_SERVER_NAME, metricsServer],
          [TRACING_SERVER_NAME, tracingServer],
          [MAIL_SERVER_NAME, mailServer],
          [WORK_ITEMS_SERVER_NAME, workItemsServer],
        ];
      phase = performance.now();
      for (const [name, server] of virtualServers) {
        const serverStart = performance.now();
        try {
          if (server) {
            const result = await withPhaseTimeout(server.stop(), SHUTDOWN_PHASE_TIMEOUT_MS, `stop ${name}`, logger);
            if (result === "timeout") {
              logger.warn(`[mcpd] Force-unregistering ${name} after stop timeout`);
            }
            pool.unregisterVirtualServer(name);
          }
        } catch (err) {
          logger.error(`[mcpd] Error stopping ${name}: ${err}`);
          pool.unregisterVirtualServer(name);
        }
        if (server) {
          logger.info(`[mcpd] Shutdown: stop ${name} took ${Math.round(performance.now() - serverStart)}ms`);
        }
      }
      logger.info(`[mcpd] Shutdown: all virtual servers took ${Math.round(performance.now() - phase)}ms`);
      // Close the shared NDJSON recorder AFTER all servers stop so final
      // messages emitted during client.close() are captured.
      if (recorder) {
        try {
          await recorder.close();
        } catch (err) {
          logger.error(`[mcpd] Error closing NDJSON recorder: ${err}`);
        }
      }
      phase = performance.now();
      try {
        await withPhaseTimeout(pool.closeAll(), SHUTDOWN_PHASE_TIMEOUT_MS, "pool.closeAll", logger);
      } catch (err) {
        logger.error(`[mcpd] Error closing server pool: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: pool.closeAll took ${Math.round(performance.now() - phase)}ms`);
      phase = performance.now();
      try {
        db.close();
      } catch (err) {
        logger.error(`[mcpd] Error closing database: ${err}`);
      }
      logger.info(`[mcpd] Shutdown: db.close took ${Math.round(performance.now() - phase)}ms`);
      if (!opts?.skipLogSetup) {
        try {
          closeDaemonLogFile();
        } catch (err) {
          logger.error(`[mcpd] Error closing log file: ${err}`);
        }
      }
      try {
        unlinkSync(options.PID_PATH);
      } catch {
        // already gone
      }
      const totalShutdownMs = Math.round(performance.now() - shutdownStart);
      logger.info(`[mcpd] Shutdown complete in ${totalShutdownMs}ms`);
    } finally {
      _resolveShutdown();
    }
  }

  return {
    shutdown,
    shutdownComplete: _shutdownComplete,
    get isShuttingDown() {
      return _isShuttingDown;
    },
    db,
    pool,
    ipcServer,
    watcher,
  };
}
