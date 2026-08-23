/**
 * @rule no-skip-permissions-flag
 * @expect 2
 * @path packages/daemon/src/example.ts
 *
 * Two ways to spawn a child with no permission gate at all — both flagged.
 */

const cmd = ["claude", "--dangerously-skip-permissions"];
const alt = ["claude", "--permission-mode", "bypassPermissions"];
export { alt, cmd };
