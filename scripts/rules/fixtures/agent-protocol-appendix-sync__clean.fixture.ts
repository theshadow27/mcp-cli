/**
 * @rule agent-protocol-appendix-sync
 * @expect 0
 * @path packages/daemon/src/abstract-worker-server.ts
 *
 * All worker event types listed here are documented in Appendix A of the
 * real docs/agent-protocol.md (read from disk) — no violation.
 */

export const BASE_WORKER_EVENT_TYPES = new Set(["ready", "db:end"]);
