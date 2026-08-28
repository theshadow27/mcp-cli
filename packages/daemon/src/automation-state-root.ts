/**
 * Lazy, retrying resolver for the automation dispatcher's `alias_state` root.
 *
 * Its own module rather than a closure in `index.ts` for two reasons: the retry policy is
 * the whole point and deserves a test, and `startDaemon` is not a testable unit.
 */

import { NO_REPO_ROOT, workItemStateRoot } from "@mcp-cli/core";
import type { Logger } from "@mcp-cli/core";

/**
 * How long to wait before re-probing after the probe came back unresolvable (#3378).
 *
 * `findGitRootResult` no longer memoizes `git-unavailable`, so without a throttle a burst
 * of automation events on a starved host would re-spawn `git rev-parse` — up to three
 * probes, 5s each — per dispatch. 30s is short enough that a recovered host is picked up
 * within one poll cycle and long enough that a storm costs one probe, not hundreds.
 */
export const STATE_ROOT_RETRY_MS = 30_000;

export interface AutomationStateRootDeps {
  /** Directory to resolve from. Read per call, not captured, so #3192 can change it. */
  cwd: () => string;
  logger: Logger;
  /** Injectable for tests; production uses the shared `workItemStateRoot`. */
  resolveRoot?: (cwd: string) => string;
  now?: () => number;
  retryMs?: number;
}

/**
 * Build the `() => string` the dispatcher's `getWorkItemState` calls.
 *
 * **Lazy on purpose.** `workItemStateRoot` spawns up to three `git rev-parse` probes at 5s
 * each, and the automation block in `startDaemon` runs *before* `ipcServer.start()` while
 * clients are already counting down `DAEMON_START_TIMEOUT_MS` (5s) before declaring
 * "Daemon failed to start". Resolving at boot turned a transient git hiccup — the documented
 * CPU-starvation failure mode on this box — into a daemon-connectivity outage at exactly
 * the highest-load moment. Nothing needs the answer until an event arrives, and by then the
 * socket is listening (#3209 review).
 *
 * **Retrying on purpose.** Resolving once and freezing meant a single bad probe made every
 * module's `getWorkItemState` read the `NO_REPO_ROOT` bucket until daemon restart, with no
 * log line marking the fallback (#3378). Only a real root is memoized; a sentinel is
 * retried after `retryMs` and warned about once per window.
 */
export function createAutomationStateRoot(deps: AutomationStateRootDeps): () => string {
  const resolveRoot = deps.resolveRoot ?? ((cwd: string) => workItemStateRoot(cwd));
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? STATE_ROOT_RETRY_MS;

  let memoized: string | null = null;
  let retryAfter = 0;

  return (): string => {
    if (memoized !== null) return memoized;
    if (now() < retryAfter) return NO_REPO_ROOT;

    const cwd = deps.cwd();
    const root = resolveRoot(cwd);
    if (root !== NO_REPO_ROOT) {
      memoized = root;
      return root;
    }

    retryAfter = now() + retryMs;
    deps.logger.warn(
      `[mcpd] Automation phase-state root could not be resolved from ${cwd} — reads will use the ${NO_REPO_ROOT} bucket and return {} until git answers. Retrying in ${retryMs / 1000}s.`,
    );
    return NO_REPO_ROOT;
  };
}
