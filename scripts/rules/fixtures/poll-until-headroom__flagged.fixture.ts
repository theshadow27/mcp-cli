/**
 * @rule poll-until-headroom
 * @expect 4
 * @path packages/daemon/src/ipc-server.spec.ts
 *
 * An explicit deadline ≥ the 5000ms watchdog can never fire its own error —
 * the watchdog kills the test first. All of these should be flagged.
 */

import { pollUntil } from "../../../../test/harness";

declare const condition: () => boolean;
declare const events: { type: string }[];

// explicit timeout exactly equal to Bun's watchdog — flag
await pollUntil(() => true, 5000);

// underscore separator, still 5000 — flag
await pollUntil(async () => condition(), 5_000);

// well above the watchdog (the real-world server-pool case) — flag
await pollUntil(() => !condition(), 10_000);

// multi-line lambda with a deadline above the watchdog — flag
await pollUntil(
  () => events.some((e) => e.type === "session:init"),
  6000,
);
