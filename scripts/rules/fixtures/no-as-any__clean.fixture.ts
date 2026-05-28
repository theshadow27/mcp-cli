/**
 * @rule no-as-any
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Proper type narrowing — no `as any` usage.
 */

const x = JSON.parse("{}") as Record<string, unknown>;
function handle(val: unknown) {
  if (typeof val === "object" && val !== null && "foo" in val) {
    return (val as { foo: string }).foo;
  }
  return undefined;
}
