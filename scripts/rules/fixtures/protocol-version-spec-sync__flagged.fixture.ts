/**
 * @rule protocol-version-spec-sync
 * @expect 1
 * @path packages/core/src/agent-protocol.ts
 *
 * Version doesn't match the spec (999 vs 1) — should fire.
 */

export const AGENT_PROTOCOL_VERSION = 999;
