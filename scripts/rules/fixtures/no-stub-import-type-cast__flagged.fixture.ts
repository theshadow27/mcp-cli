/**
 * @rule no-stub-import-type-cast
 * @expect 1
 * @path scripts/_runner/example.spec.ts
 *
 * Suppressive `as ReturnType<typeof import(...)>` cast in a test stub — flagged.
 */

const noGraph = (): ReturnType<typeof import("../rules/_engine/import-graph").buildImportGraph> =>
  ({ forward: new Map() }) as ReturnType<typeof import("../rules/_engine/import-graph").buildImportGraph>;
