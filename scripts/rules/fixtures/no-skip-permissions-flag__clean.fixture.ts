/**
 * @rule no-skip-permissions-flag
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * The two postures the daemon can reason about: the child's classifier gates,
 * or the daemon does via the can_use_tool round-trip.
 */

const childGated = ["claude", "--permission-mode", "auto"];
const daemonGated = ["claude", "--permission-mode", "default", "--permission-prompt-tool", "stdio"];
export { childGated, daemonGated };
