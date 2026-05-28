/**
 * @rule no-as-any
 * @expect 2
 * @path packages/daemon/src/example.ts
 *
 * Two `as any` casts in production code — both should be flagged.
 */

const x = JSON.parse("{}") as any;
function handle(val: unknown) {
  return (val as any).foo;
}
