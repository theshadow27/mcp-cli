/**
 * Shared-worktree guard — refuse to spawn a session into a directory another
 * LIVE session is already working in (#3140).
 *
 * Two agents in one working tree do not conflict the way two agents in one repo
 * do. There is no merge, no rebase, no error: one simply writes over the other's
 * uncommitted edits, and each experiences it as its own files mysteriously
 * changing. Both recorded incidents ended a keystroke away from destroying real
 * work — one session was about to force-push over a commit it did not know
 * existed, another had 775 uncommitted lines written into its tree by a peer.
 *
 * The check lives here, in the daemon, for the same reason domain resolution
 * does (`session-domain.ts`): the daemon is the only party that knows every
 * session's `cwd`, and it is the single point every provider's spawn passes
 * through. A CLI-side check would be a TOCTOU race against itself.
 *
 * ## What "live" means, and why the definition is the whole feature
 *
 * Reusing one worktree ACROSS sessions is the normal pipeline, not an edge case:
 * one branch is carried impl → review → repair → QA by a fresh session per
 * phase, each pointed at the same directory with `--cwd`. So this guard must
 * refuse concurrent sharing without ever refusing sequential handoff. A session
 * holds its directory only while it is live:
 *
 *   - ended (`ended_at` set, or state `ended`) → NOT a holder. This is the
 *     handoff case, and it holds whether or not the worktree was preserved:
 *     `bye --keep-worktree` keeps the directory, not the claim on it.
 *   - no pid yet → a holder. The row is written `connecting` before the child
 *     is spawned; the orphan reaper ends pid-less rows at startup, so a pid-less
 *     active row during normal operation is a spawn in flight.
 *   - pid dead or recycled → NOT a holder. The reaper only runs at daemon
 *     startup, so a crashed session leaves an active row behind indefinitely.
 *     Refusing on one of those would wedge the pipeline with no way out but the
 *     override flag, which is exactly the false positive worth avoiding.
 *   - pid alive but ownership unconfirmable → a holder, matching
 *     `reapOrphanedSessions`' "preserving, ownership uncertain" branch.
 *
 * ## Exact paths only
 *
 * A containment/prefix rule would be worse than nothing here: worktrees live
 * under `<repo>/.claude/worktrees/`, so a single session sitting at the repo
 * root would block every worktree spawn beneath it. "Same working tree" is
 * spelled as "same directory", compared after realpath resolution.
 */

import { consoleLogger, resolveRealpath } from "@mcp-cli/core";
import { isOurProcess } from "./process-identity";
import { classifyAgentTool } from "./session-domain";

/**
 * The slice of a session row this guard reads. Narrow on purpose — `AgentSessionRow`
 * satisfies it structurally, so the rule can be tested without a SQLite file.
 */
export interface HolderRow {
  sessionId: string;
  name: string | null;
  provider: string;
  state: string;
  cwd: string | null;
  pid: number | null;
  pidStartTime: number | null;
  endedAt: string | null;
}

/** The slice of `McxDb` this guard needs. */
export interface SessionLookup {
  listSessions(active?: boolean): HolderRow[];
}

/** The argument name a caller sets (via `--allow-shared-worktree`) to opt out. */
export const ALLOW_SHARED_WORKTREE_ARG = "allowSharedWorktree";

/** Thrown when a spawn targets a directory a live session already holds. */
export class SharedWorktreeError extends Error {
  constructor(
    readonly cwd: string,
    readonly holders: HolderRow[],
    message?: string,
  ) {
    super(message ?? formatRefusal(cwd, holders));
    this.name = "SharedWorktreeError";
  }
}

function describeHolder(h: HolderRow): string {
  return h.name
    ? `${h.sessionId} (${h.name}, ${h.provider}, ${h.state})`
    : `${h.sessionId} (${h.provider}, ${h.state})`;
}

function formatRefusal(cwd: string, holders: HolderRow[]): string {
  const shown = holders.slice(0, 3).map(describeHolder);
  const more = holders.length > shown.length ? `, and ${holders.length - shown.length} more` : "";
  const who = holders.length === 1 ? "a live session is" : `${holders.length} live sessions are`;
  const first = holders[0];
  return [
    `refusing to spawn into ${cwd}: ${who} already working there — ${shown.join("; ")}${more}.`,
    "Two agents in one working tree overwrite each other's uncommitted work with no error and no merge.",
    // The way out belongs in the message: whoever hits this is mid-orchestration
    // and will not go reading source to find the flag.
    first ? `End it first with \`mcx agent ${first.provider} bye ${first.sessionId}\` — an ended` : "An ended",
    "session does not hold its directory, even when the worktree was kept — or pass",
    "--allow-shared-worktree if sharing is what you meant.",
  ].join(" ");
}

/**
 * Is this process still alive AND still the process the row recorded?
 *
 * `process.kill(pid, 0)` first because it is free; `isOurProcess` (which shells
 * out to `ps`) only runs for a pid that answered, and only to rule out recycling.
 */
function defaultIsAlive(pid: number, pidStartTime: number | null): boolean {
  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!alive) return false;
  if (pidStartTime === null) return true;
  // `null` is "ps could not tell" — an alive pid we cannot identify is still a
  // process in that directory, and the reaper treats it the same way.
  return isOurProcess(pid, pidStartTime) !== false;
}

export interface WorktreeGuardDeps {
  /** Injectable for tests — defaults to a kill(0) probe plus a recycle check. */
  isAlive?: (pid: number, pidStartTime: number | null) => boolean;
  /** Injectable for tests — defaults to `resolveRealpath`. */
  realpath?: (path: string) => string;
  /** Where the override notice goes. Defaults to the daemon log. */
  warn?: (message: string) => void;
}

/** True when this row's session still occupies its working directory. */
export function isHoldingSession(row: HolderRow, isAlive: (pid: number, start: number | null) => boolean): boolean {
  if (row.endedAt !== null) return false;
  if (row.state === "ended") return false;
  // Written `connecting` before the child exists — a spawn in flight, not a corpse.
  if (row.pid === null) return true;
  return isAlive(row.pid, row.pidStartTime);
}

/**
 * Guards the one code path that can create a second agent in an occupied tree.
 *
 * A class rather than module functions because it owns the in-flight reservation
 * set: two spawns dispatched in the same tick would both read a DB that has no
 * row for either of them yet, and both would be allowed. The reservation closes
 * that window — a spawn claims its directory before it is dispatched and holds
 * the claim until `callTool` settles, by which point the session's row exists.
 */
export class SharedWorktreeGuard {
  /** cwd → number of spawns dispatched but not yet settled. */
  private pending = new Map<string, number>();
  private readonly isAlive: (pid: number, start: number | null) => boolean;
  private readonly realpath: (path: string) => string;
  private readonly warn: (message: string) => void;

  constructor(
    private db: SessionLookup,
    deps: WorktreeGuardDeps = {},
  ) {
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.realpath = deps.realpath ?? resolveRealpath;
    this.warn = deps.warn ?? ((m) => consoleLogger.warn(m));
  }

  /** Live sessions whose working directory is exactly `cwd`. */
  holdersOf(cwd: string): HolderRow[] {
    const target = this.safeRealpath(cwd);
    return this.db
      .listSessions(true)
      .filter((row) => row.cwd !== null && this.safeRealpath(row.cwd) === target)
      .filter((row) => isHoldingSession(row, this.isAlive));
  }

  /**
   * Check a `callTool` dispatch, returning the args to forward and a release
   * handle the caller MUST invoke when the call settles.
   *
   * A strict no-op for every server and tool it does not own — this runs for
   * every `callTool` on the daemon, including third-party MCP servers, so
   * ownership is decided before anything is read or stripped.
   */
  check(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): { args: Record<string, unknown>; release: () => void } {
    if (classifyAgentTool(serverName, toolName) !== "spawn") return { args, release: () => {} };

    // Never forward the override to a worker: it is a boundary decision, made here.
    const { [ALLOW_SHARED_WORKTREE_ARG]: override, ...rest } = args;

    // A resume targets an existing session and changes no directory, so it is not
    // a second agent in the tree — `sessionId` present means "follow-up prompt".
    if (typeof rest.sessionId === "string") return { args: rest, release: () => {} };

    const cwd = typeof rest.cwd === "string" ? rest.cwd : undefined;
    if (cwd === undefined) return { args: rest, release: () => {} };
    const target = this.safeRealpath(cwd);

    if (override === true) {
      const holders = this.holdersOf(cwd);
      if (holders.length > 0) {
        this.warn(
          `[mcpd] --allow-shared-worktree: spawning into ${cwd} while ${holders.length} live session(s) hold it — ${holders.map(describeHolder).join("; ")}`,
        );
      }
      return { args: rest, release: this.reserve(target) };
    }

    const holders = this.holdersOf(cwd);
    if (holders.length > 0) throw new SharedWorktreeError(cwd, holders);
    if ((this.pending.get(target) ?? 0) > 0) {
      throw new SharedWorktreeError(
        cwd,
        [],
        [
          `refusing to spawn into ${cwd}: another spawn into the same directory is already in flight`,
          "and has not registered its session yet. Two agents in one working tree overwrite each",
          "other's uncommitted work. Retry once it has started, or pass --allow-shared-worktree if",
          "sharing is what you meant.",
        ].join(" "),
      );
    }

    return { args: rest, release: this.reserve(target) };
  }

  private reserve(target: string): () => void {
    this.pending.set(target, (this.pending.get(target) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.pending.get(target) ?? 1) - 1;
      if (next <= 0) this.pending.delete(target);
      else this.pending.set(target, next);
    };
  }

  /** realpath, degrading to the raw path — an unreadable path is not a reason to fail a spawn. */
  private safeRealpath(path: string): string {
    try {
      return this.realpath(path);
    } catch {
      return path;
    }
  }
}
