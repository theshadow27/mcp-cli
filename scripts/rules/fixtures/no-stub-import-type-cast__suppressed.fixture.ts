/**
 * @rule no-stub-import-type-cast
 * @expect 0
 * @path scripts/_runner/example.spec.ts
 *
 * The dotw-ignore comment suppresses the cast on that line.
 */

const noGraph = () =>
  // dotw-ignore no-stub-import-type-cast: legacy stub, tracked for removal
  ({ forward: new Map() }) as ReturnType<typeof import("../rules/_engine/import-graph").buildImportGraph>;
