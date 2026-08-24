/**
 * Process-group tracking for the `am-i-done` wall-clock deadline (#3261).
 *
 * ## Why a process GROUP and not just the child
 *
 * The failure this exists for (#2973 / #3250) is a *grandchild*: `bun test`
 * loses a SIGCHLD, and a leftover worker spins at 97% CPU with a dead event
 * loop. SIGTERM to the direct `bun` process does not reach it — and if the
 * direct child dies first, the spinner is re-parented to init and survives
 * the whole run. Signalling the direct pid is therefore not a kill, it is a
 * pid leak with extra steps.
 *
 * So every child the gate spawns is started `detached: true` — on POSIX that
 * is `setsid(2)`, which makes the child a session AND process-group leader
 * with pgid == pid. Descendants inherit that pgid unless they call setsid
 * themselves (bun's test workers do not), so `kill(-pid, sig)` delivers to
 * the whole tree in one syscall. No `ps` parsing, no descendant walking, no
 * host-wide process hunting — the banned sprint-69/70 pattern (#2637) is
 * specifically a *reaper that runs during a healthy run*. This signals only
 * the groups this process itself created, and only once, at the deadline.
 *
 * ## Consequence: signals no longer arrive by terminal
 *
 * A detached child leaves our foreground process group, so a Ctrl-C at the
 * terminal reaches `am-i-done` but NOT its children. `am-i-done.ts` therefore
 * installs SIGINT/SIGTERM handlers that call `killTrackedTree()` — without
 * them, interrupting the gate would strand a full `bun test` fan-out.
 */

import {
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
  spawn,
} from "node:child_process";
import type { Readable } from "node:stream";

/** How long the tree gets to exit on SIGTERM before SIGKILL follows. */
export const TERM_GRACE_MS = 2_000;
/** How long we wait for the groups to actually disappear after SIGKILL. */
const REAP_VERIFY_MS = 2_000;
/** Liveness poll interval — we test the CONDITION (group gone), not elapsed time. */
const REAP_POLL_MS = 20;

/** Children spawned by the gate, still running. */
const tracked = new Set<ChildProcessByStdio<null, Readable, Readable>>();

export interface TrackedSpawnOptions {
  env: Record<string, string>;
  cwd?: string;
}

/**
 * `spawn()` a piped child in its own process group and remember it, so a
 * deadline expiry can signal the entire descendant tree. Drop-in replacement
 * for `spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] })`.
 */
export function spawnTracked(
  cmd: string,
  args: string[],
  opts: TrackedSpawnOptions,
): ChildProcessByStdio<null, Readable, Readable> {
  const options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    // setsid: the child leads its own group so kill(-pid) reaches the tree.
    detached: true,
  };
  if (opts.cwd) options.cwd = opts.cwd;

  const child = spawn(cmd, args, options);
  tracked.add(child);
  const forget = (): void => {
    tracked.delete(child);
  };
  child.once("close", forget);
  child.once("error", forget);
  return child;
}

/** Pids (== process-group ids) of every child still tracked. Exposed for tests. */
export function trackedPids(): number[] {
  return [...tracked].map((c) => c.pid).filter((p): p is number => typeof p === "number");
}

/** True while any process in `pid`'s group still exists (including zombies). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // ESRCH — the whole group is gone. EPERM cannot happen for a group we made.
    return false;
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // Group already exited between the liveness check and the signal.
  }
}

async function waitForGroupsGone(pids: number[], budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!pids.some(groupAlive)) return;
    await Bun.sleep(REAP_POLL_MS);
  }
}

export interface KillTreeResult {
  /** Process groups that were signalled. */
  killed: number[];
  /** Groups still alive after SIGKILL + verification window — should always be empty. */
  survivors: number[];
}

/**
 * SIGTERM every tracked process group, wait (condition-based) for them to go,
 * then SIGKILL whatever is left and verify. Returns which groups were signalled
 * and which — if any — refused to die, so the caller can say so out loud rather
 * than claim a clean kill it did not achieve.
 */
export async function killTrackedTree(opts: { graceMs?: number } = {}): Promise<KillTreeResult> {
  const graceMs = opts.graceMs ?? TERM_GRACE_MS;
  const killed = trackedPids();
  if (killed.length === 0) return { killed, survivors: [] };

  for (const pid of killed) signalGroup(pid, "SIGTERM");
  await waitForGroupsGone(killed, graceMs);

  const stubborn = killed.filter(groupAlive);
  for (const pid of stubborn) signalGroup(pid, "SIGKILL");
  await waitForGroupsGone(stubborn, REAP_VERIFY_MS);

  return { killed, survivors: killed.filter(groupAlive) };
}
