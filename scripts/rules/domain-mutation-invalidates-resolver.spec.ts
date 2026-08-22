import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { evaluateRule } from "./_engine/rule";
import rule from "./domain-mutation-invalidates-resolver.rule";

function makeFile(content: string, relPath = "packages/daemon/src/handlers/domain.ts"): FileMeta {
  return { path: relPath, relPath, content, pkg: "packages/daemon", isTest: false };
}

function evaluate(file: FileMeta) {
  return evaluateRule(rule, file, new Map([[file.path, file]]));
}

describe("domain-mutation-invalidates-resolver", () => {
  it("flags a createDomain call with no invalidate", () => {
    const violations = evaluate(
      makeFile(`handlers.set("domainAdd", async (params) => {
  const domain = this.db.createDomain(params.name, params.path);
  return { domain };
});`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it("flags renameDomain and deleteDomain too", () => {
    expect(evaluate(makeFile("this.db.renameDomain(a, b);"))).toHaveLength(1);
    expect(evaluate(makeFile("this.db.deleteDomain(name, { cascade: true });"))).toHaveLength(1);
  });

  it("reports every unguarded mutation in the file, not just the first", () => {
    expect(evaluate(makeFile("db.createDomain(a, b);\ndb.deleteDomain(c);"))).toHaveLength(2);
  });

  it("accepts a mutation paired with an invalidate", () => {
    const violations = evaluate(
      makeFile(`const domain = this.db.createDomain(name, path);
this.domains.invalidate();
return { domain };`),
    );
    expect(violations).toHaveLength(0);
  });

  // ── Bypasses that used to report clean (#3040 review R5) ──

  it("an UNRELATED receiver's .invalidate() does not silence the rule", () => {
    // The exact reported reproduction: file-wide boolean, no receiver check → 0 violations.
    const violations = evaluate(makeFile("db.createDomain(a, b);\nunrelatedCache.invalidate();"));
    expect(violations).toHaveLength(1);
  });

  it("invalidating BEFORE the mutation does not count — the memo is stale again after", () => {
    const violations = evaluate(makeFile("domains.invalidate();\ndb.createDomain(a, b);"));
    expect(violations).toHaveLength(1);
  });

  it("an invalidate in a DIFFERENT function does not cover this mutation", () => {
    const violations = evaluate(
      makeFile(`export function add(name: string, path: string) {
  db.createDomain(name, path);
}
export function unrelated() {
  domains.invalidate();
}`),
    );
    expect(violations).toHaveLength(1);
  });

  it("accepts a resolver-named receiver invalidating after, in the same function", () => {
    for (const receiver of ["domains", "domainResolver", "this.domains", "this.domainResolver"]) {
      const violations = evaluate(
        makeFile(`export function add(n: string, p: string) {
  db.createDomain(n, p);
  ${receiver}.invalidate();
}`),
      );
      expect(violations, receiver).toHaveLength(0);
    }
  });

  it("flags only the uncovered mutation when a file has both", () => {
    const violations = evaluate(
      makeFile(`export function good(n: string, p: string) {
  db.createDomain(n, p);
  domains.invalidate();
}
export function bad(n: string) {
  db.deleteDomain(n);
}`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("deleteDomain");
  });

  // ── Residual bypasses found by the delta review (#3169) ──

  it("a receiver that merely CONTAINS a resolver word does not silence the rule", () => {
    for (const receiver of ["domainNameCache", "pathResolverCache", "domainsBackup"]) {
      const violations = evaluate(
        makeFile(`export function add(n: string, p: string) {
  db.createDomain(n, p);
  ${receiver}.invalidate();
}`),
      );
      expect(violations, receiver).toHaveLength(1);
    }
  });

  it("a nested resolver receiver is still accepted via its final segment", () => {
    const violations = evaluate(
      makeFile(`export function add(n: string, p: string) {
  db.createDomain(n, p);
  this.deps.domains.invalidate();
}`),
    );
    expect(violations).toHaveLength(0);
  });

  it("a DESTRUCTURED mutation is caught, not invisible", () => {
    const violations = evaluate(
      makeFile(`const { createDomain } = db;
export function add(n: string, p: string) {
  createDomain(n, p);
}`),
    );
    expect(violations).toHaveLength(1);
  });

  it("a destructured mutation paired with a proper invalidate is accepted", () => {
    const violations = evaluate(
      makeFile(`const { createDomain } = db;
export function add(n: string, p: string) {
  createDomain(n, p);
  domains.invalidate();
}`),
    );
    expect(violations).toHaveLength(0);
  });

  it("says nothing about a file that never touches the domains table", () => {
    expect(evaluate(makeFile("const id = this.domains.idForPath(repoRoot);"))).toHaveLength(0);
  });

  // The db layer defines these methods and the resolver is what gets invalidated;
  // neither is a caller, and flagging them would make the rule un-satisfiable.
  it("exempts the db layer, the resolver, and core's domain module", () => {
    for (const p of [
      "packages/daemon/src/db/state.ts",
      "packages/daemon/src/db/import-legacy.ts",
      "packages/daemon/src/domain-resolver.ts",
      "packages/core/src/domain.ts",
    ]) {
      expect(evaluate(makeFile("db.createDomain(a, b);", p)), p).toHaveLength(0);
    }
  });

  it("ignores files outside packages/", () => {
    expect(evaluate(makeFile("db.createDomain(a, b);", "scripts/tool.ts"))).toHaveLength(0);
  });
});
