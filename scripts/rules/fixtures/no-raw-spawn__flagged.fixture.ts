/**
 * @rule no-raw-spawn
 * @expect 3
 * @path packages/daemon/src/example.ts
 *
 * A bare Bun.spawnSync call, an exitCode ?? 0 null-coercion, and an
 * optional-chaining exitCode coercion (result?.exitCode ?? 0).
 */

const result = Bun.spawnSync(["git", "status"], { stdout: "pipe" });
const code = result.exitCode ?? 0;
const safe = result?.exitCode ?? 0;
