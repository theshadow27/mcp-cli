/**
 * @rule provider-drift
 * @expect 1
 * @path packages/daemon/src/fakeprovider-session-worker.ts
 *
 * `fakeprovider` has a session worker but is absent from the real
 * agent-grid/versions-schema.ts PROVIDER_NAMES array — should fire once.
 */

export const worker = "fakeprovider";
