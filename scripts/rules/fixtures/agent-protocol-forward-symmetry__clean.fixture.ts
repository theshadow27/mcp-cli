/**
 * @rule agent-protocol-forward-symmetry
 * @expect 0
 * @path packages/daemon/src/abstract-worker-server.ts
 *
 * The rule is cross-file: it runs on the anchor and compares the
 * forwardSessionEvent handlers of the *-session-worker.ts files in the loaded
 * set. In fixture mode only this single anchor file is present, so no provider
 * class forms and there is no violation. The behavioral matrix (asymmetry
 * flagged, cross-vocabulary non-comparison) is covered in the .spec.ts, which
 * can supply a multi-file set.
 */

export const BASE_WORKER_EVENT_TYPES = new Set(["ready"]);
