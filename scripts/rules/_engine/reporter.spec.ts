import { describe, expect, it } from "bun:test";

import type { Logger } from "../../_runner/types";
import { reportViolations } from "./reporter";
import type { PatternRule, Violation } from "./rule";

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push(`${level}:${args.join(" ")}`);
  return {
    lines,
    logger: { debug: sink("debug"), info: sink("info"), warn: sink("warn"), error: sink("error") },
  };
}

function rule(overrides: Partial<PatternRule> = {}): PatternRule {
  return {
    kind: "pattern",
    id: "shell-injection",
    scold: "execSync called with interpolated template literal",
    guidance: ["use spawnSync('git', [...])", "bash $() survives JSON.stringify"],
    pattern: /x/,
    ...overrides,
  };
}

function violation(r: PatternRule, line: number): Violation {
  return { file: "packages/foo/src/bar.ts", line, column: 5, snippet: `execSync(line ${line})`, rule: r };
}

describe("reportViolations", () => {
  it("reports a clean tree with the no-violations sigil and emits no warnings", () => {
    const { logger, lines } = captureLogger();
    reportViolations([], { logger });
    expect(lines).toEqual(["info:✨ no rule violations"]);
  });

  it("groups by rule, scolds once per group, and prints each file:line:column + snippet", () => {
    const { logger, lines } = captureLogger();
    const r = rule({ documentation: "CLAUDE.md#no-shell-interpolation" });
    reportViolations([violation(r, 42), violation(r, 17)], { logger });
    const text = lines.join("\n");
    expect(text).toContain("━━━ rule: shell-injection ━━━");
    expect(text).toContain("(2 violations)");
    expect(text).toContain("packages/foo/src/bar.ts:42:5");
    expect(text).toContain("packages/foo/src/bar.ts:17:5");
    expect(text).toContain("📚 see: CLAUDE.md#no-shell-interpolation");
    // guidance is emitted once per group, not once per violation
    expect(lines.filter((l) => l.includes("• use spawnSync")).length).toBe(1);
    expect(text).toContain("2 violations across 1 rule");
  });

  it("uses singular nouns for a single violation across a single rule", () => {
    const { logger, lines } = captureLogger();
    reportViolations([violation(rule(), 1)], { logger });
    const text = lines.join("\n");
    expect(text).toContain("(1 violation)");
    expect(text).toContain("1 violation across 1 rule");
  });

  it("caps the per-rule display at perRuleLimit and shows the '… and N more' hint", () => {
    const { logger, lines } = captureLogger();
    const r = rule();
    const many = Array.from({ length: 8 }, (_, i) => violation(r, i + 1));
    reportViolations(many, { logger, perRuleLimit: 3 });
    const text = lines.join("\n");
    expect(text).toContain("... and 5 more (use --all to show all)");
    // only the first 3 file rows are shown
    expect(lines.filter((l) => l.includes("packages/foo/src/bar.ts:")).length).toBe(3);
  });

  it("showAll overrides the per-rule limit and omits the '… and N more' hint", () => {
    const { logger, lines } = captureLogger();
    const r = rule();
    const many = Array.from({ length: 8 }, (_, i) => violation(r, i + 1));
    reportViolations(many, { logger, showAll: true, perRuleLimit: 3 });
    const text = lines.join("\n");
    expect(text).not.toContain("more (use --all");
    expect(lines.filter((l) => l.includes("packages/foo/src/bar.ts:")).length).toBe(8);
  });

  it("omits the documentation pointer when the rule has none, and counts multiple rules", () => {
    const { logger, lines } = captureLogger();
    const a = rule({ id: "rule-a", documentation: undefined });
    const b = rule({ id: "rule-b", documentation: undefined });
    reportViolations([violation(a, 1), violation(b, 2)], { logger });
    const text = lines.join("\n");
    expect(text).not.toContain("📚 see:");
    expect(text).toContain("2 violations across 2 rules");
  });
});
