/**
 * Environment-variable helpers for tests.
 *
 * `process.env.FOO = undefined` does **not** remove `FOO` — the assignment
 * stringifies, leaving the literal string `"undefined"` behind, which is truthy
 * and leaks into every later test in the file. Bun 1.3.x happened to read the
 * key back as `undefined`, which hid the bug; Bun >= 1.4 matches Node and
 * returns `"undefined"`, which exposed it (#2984). Removal is the only correct
 * operation, on every runtime.
 *
 * `Reflect.deleteProperty` rather than the `delete` operator: biome's
 * `performance/noDelete` rule flags `delete`, and its suggested fix is
 * `= undefined` — i.e. the exact bug this module exists to prevent.
 */

/** Remove an environment variable (the correct way to "unset" it). */
export function unsetEnv(name: string): void {
  Reflect.deleteProperty(process.env, name);
}

/**
 * Restore an environment variable to a value captured before a test mutated it.
 * A captured value of `undefined` means "was not set", so the key is removed.
 */
export function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) unsetEnv(name);
  else process.env[name] = prev;
}
