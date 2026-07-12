/**
 * @rule no-stub-import-type-cast
 * @expect 0
 * @path scripts/_runner/example.spec.ts
 *
 * Direct return-type annotation — the good shape the rule steers toward.
 */

import type { ImportGraph } from "../rules/_engine/import-graph";

const noGraph = (): ImportGraph => ({ forward: new Map(), reverse: new Map() });
