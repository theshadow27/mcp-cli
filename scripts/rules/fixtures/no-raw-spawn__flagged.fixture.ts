/**
 * @rule no-raw-spawn
 * @expect 2
 * @path packages/daemon/src/example.ts
 *
 * A bare Bun.spawnSync call and an exitCode ?? 0 null-coercion.
 */

const result = Bun.spawnSync(["git", "status"], { stdout: "pipe" });
const code = result.exitCode ?? 0;
