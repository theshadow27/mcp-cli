/**
 * @rule poll-until-headroom
 * @expect 4
 * @path packages/daemon/src/ipc-server.spec.ts
 *
 * pollUntil with no timeout (relying on the 5000ms default) or an explicit
 * timeout >= 5000ms should all be flagged.
 */

import { pollUntil } from "../../../../test/harness";

declare const condition: () => boolean;
declare const events: { type: string }[];

// no second argument — default 5000ms — flag
await pollUntil(condition);

// explicit timeout exactly equal to Bun's watchdog — flag
await pollUntil(() => true, 5000);

// underscore separator, still 5000 — flag
await pollUntil(async () => condition(), 5_000);

// multi-line lambda, no timeout — flag
await pollUntil(
  () => events.some((e) => e.type === "session:init")
);
