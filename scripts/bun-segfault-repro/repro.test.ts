/**
 * Standalone reproduction for Bun worker-cleanup segfault (#1004).
 *
 * Root cause: JSC::DeferredWorkTimer holds raw JSCell* pointers after the
 * worker VM shuts down. During Bun's cleanup/coverage-serialization phase,
 * the timer fires on the freed VM → SIGILL / Segmentation fault.
 *
 * Upstream issue: https://github.com/oven-sh/bun/issues/28415
 * Fix PRs:        https://github.com/oven-sh/bun/pull/27960
 *                 https://github.com/oven-sh/bun/pull/28795
 *
 * ## Reproducing
 *
 *   bun test --coverage scripts/bun-segfault-repro/
 *
 * ## Expected results
 *
 * | Build                  | Segfault rate |
 * |------------------------|---------------|
 * | Bun ≤ 1.3.12 (stock)  | ~60%          |
 * | PR #27960 canary       | 0%            |
 * | PR #28795 canary       | 0%            |
 *
 * To test a fix PR:
 *
 *   bunx bun-pr 27960  # installs the canary build
 *   bun test --coverage scripts/bun-segfault-repro/
 *
 * ## A/B test data (collected 2026-04-10, mcp-cli project)
 *
 *   Baseline (1.3.12):  22/37 runs segfaulted (59%)
 *   PR #27960 canary:   0/100 runs segfaulted (0%)
 *   PR #28795 canary:   0/100 runs segfaulted (0%)
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

// 60 workers is enough to trigger the crash reliably on stock Bun 1.3.x.
// The project's full daemon test suite spawns 85–97 workers and crashes at ~59%.
const WORKER_COUNT = 60;
const WORKER_PATH = resolve(import.meta.dir, "worker.ts");

describe("Bun worker-cleanup segfault repro (oven-sh/bun#28415)", () => {
  it(`spawns ${WORKER_COUNT} workers with pending deferred work, then terminates them`, async () => {
    const workers: Worker[] = [];

    for (let i = 0; i < WORKER_COUNT; i++) {
      workers.push(new Worker(WORKER_PATH));
    }

    // Wait for all workers to signal ready (server up, interval running).
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("worker ready timeout")), 10_000);
            w.onmessage = (e) => {
              if (e.data?.type === "ready") {
                clearTimeout(timeout);
                w.onmessage = null;
                resolve();
              }
            };
            w.onerror = (e) => {
              clearTimeout(timeout);
              reject(new Error(`worker error: ${e}`));
            };
          }),
      ),
    );

    // Terminate all workers without waiting for their pending fetch/interval
    // to complete. This leaves DeferredWorkTimer tickets pointing at freed VMs.
    for (const w of workers) {
      w.terminate();
    }

    expect(workers.length).toBe(WORKER_COUNT);
    // The segfault occurs after this assertion, during Bun's
    // coverage-serialization / VM-cleanup phase — not during the test itself.
  }, 120_000);
});
