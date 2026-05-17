/**
 * Autoloaded fixture tests.
 *
 * Globs `scripts/rules/fixtures/` for `*.fixture.ts(x)` files, parses
 * each frontmatter (@rule, @expect, @path), runs the named rule against
 * the fixture body, and asserts the violation count matches @expect.
 *
 * Fixtures with @expect 0 prove that the rule does NOT fire on known-good
 * shapes. Fixtures with @expect >0 prove it DOES fire on known-bad shapes.
 * Both are first-class — the negative cases catch regressions where a
 * regex tightens up and stops matching intended targets.
 *
 * Suppression is applied at this boundary (same as production), so a
 * fixture with `// dotw-ignore <rule>: ...` must have @expect 0 — the
 * suppression machinery is part of what's under test.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { loadAllFixtures } from "./_engine/fixture-loader";
import { evaluateRule } from "./_engine/rule";
import { checkSuppression } from "./_engine/suppression";
import { findRule, RULES } from "./index";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

describe("rule fixtures", async () => {
  const fixtures = await loadAllFixtures(FIXTURE_DIR);

  it("every registered rule has at least one fixture", () => {
    const covered = new Set(fixtures.map((f) => f.frontmatter.rule));
    const missing = RULES.filter((r) => !covered.has(r.id));
    expect(missing.map((r) => r.id)).toEqual([]);
  });

  for (const fix of fixtures) {
    it(`${fix.fileName} → @rule ${fix.frontmatter.rule} expects ${fix.frontmatter.expect} violation(s)`, () => {
      const rule = findRule(fix.frontmatter.rule);
      expect(rule, `rule '${fix.frontmatter.rule}' is not registered`).toBeDefined();
      if (!rule) return;

      const raw = evaluateRule(rule, fix.fileMeta, new Map([[fix.fileMeta.path, fix.fileMeta]]));
      const surviving = raw.filter((v) => !checkSuppression(fix.body, v.line, rule.id).suppressed);
      expect(surviving).toHaveLength(fix.frontmatter.expect);
    });
  }
});
