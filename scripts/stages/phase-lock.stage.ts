import type { Stage } from "am-i-done";

/**
 * A committed .mcx.lock that has drifted from the phase/automation sources, including an edit to a
 * transitive import such as review-fn.ts (#2656). `mcx phase check` hashes the whole local-import
 * closure, resolved against this worktree's own root (#2737), so it runs in the hooks too.
 */
export default {
  id: "phase-lock",
  description: "verify .mcx.lock matches the phase/automation source closure (mcx phase check)",
  command: "bun packages/command/src/main.ts phase check",
  onFailure: [
    "a phase/automation source changed without re-install — including a transitive import like *-fn.ts",
    "run `bun packages/command/src/main.ts phase install` and commit the updated .mcx.lock",
  ],
} satisfies Stage;
