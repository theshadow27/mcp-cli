/**
 * @rule provider-drift
 * @expect 0
 * @path packages/daemon/src/fakeprovider-session-worker.ts
 *
 * A *-session-worker.ts file that is not an agent provider is exempted by
 * an in-file dotw-ignore annotation — should not fire even though
 * `fakeprovider` is absent from PROVIDER_NAMES.
 */

// dotw-ignore provider-drift: fakeprovider is a test fixture, not a real agent provider
export const worker = "fakeprovider";
