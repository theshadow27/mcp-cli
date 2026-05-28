/**
 * @rule no-as-any
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Suppressed `as any` — the dotw-ignore comment prevents flagging.
 */

const x = JSON.parse("{}") as any; // dotw-ignore no-as-any: third-party interop requires untyped cast
