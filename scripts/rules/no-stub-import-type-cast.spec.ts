import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { evaluateRule } from "./_engine/rule";
import rule from "./no-stub-import-type-cast.rule";

function makeSpec(content: string): FileMeta {
  const relPath = "scripts/_runner/example.spec.ts";
  return { path: relPath, relPath, content, pkg: "scripts/_runner", isTest: true };
}

function evaluate(file: FileMeta) {
  return evaluateRule(rule, file, new Map([[file.path, file]]));
}

describe("no-stub-import-type-cast", () => {
  it("flags the confirmed ci-steps.spec.ts pattern", () => {
    const spec = makeSpec(
      `const noGraph = (): ReturnType<typeof import("../rules/_engine/import-graph").buildImportGraph> =>\n` +
        `  ({ forward: new Map() } as ReturnType<typeof import("../rules/_engine/import-graph").buildImportGraph>);`, // dotw-ignore no-stub-import-type-cast: fixture string, not real code
    );
    const violations = evaluate(spec);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it("tolerates whitespace variations", () => {
    const spec = makeSpec(`const x = ({} as  ReturnType < typeof   import ("./m").fn>);`); // dotw-ignore no-stub-import-type-cast: fixture string, not real code
    expect(evaluate(spec)).toHaveLength(1);
  });

  it("does not flag a plain ReturnType return annotation (no `as` cast)", () => {
    const spec = makeSpec(`const f = (): ReturnType<typeof import("./m").fn> => ({});`);
    expect(evaluate(spec)).toHaveLength(0);
  });

  it("does not flag a direct return-type annotation with satisfies", () => {
    const spec = makeSpec(`import type { T } from "./m";\nconst stub = { forward: new Map() } satisfies T;`);
    expect(evaluate(spec)).toHaveLength(0);
  });

  it("does not flag an unrelated `as SomeType` cast", () => {
    const spec = makeSpec("const x = value as SomeConcreteType;");
    expect(evaluate(spec)).toHaveLength(0);
  });

  it("honors the dotw-ignore suppression", () => {
    const spec = makeSpec(
      `const x = ({} as ReturnType<typeof import("./m").fn>); // dotw-ignore no-stub-import-type-cast: legacy`,
    );
    expect(evaluate(spec)).toHaveLength(0);
  });

  it("does not run on non-test files (appliesToTests: true)", () => {
    const prod: FileMeta = { ...makeSpec(`const x = ({} as ReturnType<typeof import("./m").fn>);`), isTest: false }; // dotw-ignore no-stub-import-type-cast: fixture string, not real code
    expect(evaluate(prod)).toHaveLength(0);
  });
});
