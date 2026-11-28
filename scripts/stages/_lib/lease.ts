/**
 * The host-wide gate lease (#2690) around a heavy test stage: N gate runs in N worktrees queue for
 * the machine instead of oversubscribing it. Admission waits, logs every 30s, and fails open; it
 * never signals anything. CI runners are hosts of their own, so CI runs unleased.
 *
 * The old runner took the lease once per run and credited the wait back to its deadline. A stage
 * runs in a process of its own, so here each leased stage takes it for its own duration, and the
 * wait counts against the stage's time (see `timeoutMs` on the leased stages and done.toml).
 */

import { type GateLease, acquireGateLease } from "@mcp-cli/core";
import type { StageOptions } from "am-i-done";

/** Lease wait ceiling (MCX_GATE_LEASE_WAIT_MS is capped at 400s in gate-lease.ts). */
export const MAX_LEASE_WAIT_MS = 400_000;

export async function withLease<T>(options: StageOptions, work: () => Promise<T>): Promise<T> {
  if (options.context === "ci") return work();
  const logger = { info: (m: string) => options.logger.info(m), warn: (m: string) => options.logger.warn(m) };
  const lease: GateLease = await acquireGateLease({ logger });
  try {
    return await work();
  } finally {
    lease.release();
  }
}
