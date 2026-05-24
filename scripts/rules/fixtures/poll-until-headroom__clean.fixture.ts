/**
 * @rule poll-until-headroom
 * @expect 0
 * @path packages/daemon/src/server-pool.spec.ts
 *
 * pollUntil calls with explicit timeouts comfortably below 5000ms — no violation.
 */

import { pollUntil } from "../../../../test/harness";

declare const condition: () => boolean;
declare const events: { type: string }[];

// explicit timeout well under 5000 — clean
await pollUntil(condition, 4000);
await pollUntil(() => true, 3_000);
await pollUntil(async () => condition(), 2000);
await pollUntil(() => events.some((e) => e.type === "done"), 1000);

// multi-line lambda with explicit safe timeout — clean
await pollUntil(
  () => events.some((e) => e.type === "session:init"),
  4000,
);
