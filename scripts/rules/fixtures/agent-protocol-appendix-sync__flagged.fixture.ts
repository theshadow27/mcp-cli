/**
 * @rule agent-protocol-appendix-sync
 * @expect 1
 * @path packages/daemon/src/abstract-worker-server.ts
 *
 * `bogus:type` is a worker event type that Appendix A cannot list — the rule
 * fires once for the undocumented type. (`ready` is documented, so it passes.)
 */

export const BASE_WORKER_EVENT_TYPES = new Set(["ready", "bogus:type"]);
