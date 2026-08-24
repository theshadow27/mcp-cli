/**
 * @rule no-skip-permissions-flag
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Naming the flag to reject it, rather than emitting it.
 */

// dotw-ignore no-skip-permissions-flag: names the rejected flag in a diagnostic, never spawns with it
const REJECTED_FLAGS = ["--dangerously-skip-permissions"];
export { REJECTED_FLAGS };
