/**
 * @rule provider-drift
 * @expect 0
 * @path packages/daemon/src/claude-session-worker.ts
 *
 * `claude` is present in the real agent-grid/versions-schema.ts
 * PROVIDER_NAMES array — no drift, should not fire.
 */

export const worker = "claude";
