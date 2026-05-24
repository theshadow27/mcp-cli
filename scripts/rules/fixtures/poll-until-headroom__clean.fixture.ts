/**
 * @rule poll-until-headroom
 * @expect 0
 * @path packages/daemon/src/server-pool.spec.ts
 *
 * No explicit timeout (relies on the safe 1500ms harness default), an explicit
 * timeout comfortably below the watchdog, or a larger deadline that still sits
 * under a file-level setDefaultTimeout — no violation.
 */

import { setDefaultTimeout } from "bun:test";
import { pollUntil } from "../../../../test/harness";

declare const condition: () => boolean;
declare const events: { type: string }[];

// slow suite raises the watchdog to 30s, so a 10s poll still has headroom
setDefaultTimeout(30_000);

// no second argument — relies on the 1500ms default — clean (idiomatic form)
await pollUntil(condition);
await pollUntil(() => events.some((e) => e.type === "done"));

// multi-line lambda, no timeout — clean
await pollUntil(
  () => events.some((e) => e.type === "session:init"),
);

// explicit timeout well under the watchdog — clean
await pollUntil(condition, 4000);
await pollUntil(() => true, 3_000);
await pollUntil(async () => condition(), 2000);
await pollUntil(() => events.some((e) => e.type === "done"), 1000);

// multi-line lambda with explicit safe timeout — clean
await pollUntil(
  () => events.some((e) => e.type === "session:init"),
  4000,
);

// 10s deadline under the 30s file-level setDefaultTimeout — clean (has headroom)
await pollUntil(() => events.some((e) => e.type === "ready"), 10_000);
