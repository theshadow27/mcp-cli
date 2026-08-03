import { describe, expect, test } from "bun:test";
import { evaluate } from "./evaluator";
import { type PermissionRule, assertValidRules, parsePattern, validateRulePattern } from "./rule";

describe("validateRulePattern", () => {
  test("rejects argPattern on an explicit tool wildcard", () => {
    const error = validateRulePattern("mcp__atlassian__*(query:*)");
    expect(error).toContain('Invalid permission rule "mcp__atlassian__*(query:*)"');
    expect(error).toContain("mcp__atlassian__*");
    expect(error).toContain("matches nothing");
  });

  test("rejects argPattern on mcp__*", () => {
    expect(validateRulePattern("mcp__*(foo)")).not.toBeNull();
  });

  // The bare-server form parses and matches via the evaluator's unknown-tool
  // `command`/`cmd`/`script` fallback, so it must NOT be rejected.
  test("accepts argPattern on a bare MCP server pattern", () => {
    expect(validateRulePattern("mcp__atlassian(query:*)")).toBeNull();
    expect(validateRulePattern("mcp__echo(:*)")).toBeNull();
  });

  test("accepts plain tool wildcards without an argPattern", () => {
    expect(validateRulePattern("mcp__atlassian__*")).toBeNull();
    expect(validateRulePattern("mcp__*")).toBeNull();
    expect(validateRulePattern("mcp__atlassian")).toBeNull();
  });

  test("accepts argPatterns on non-wildcard tools", () => {
    expect(validateRulePattern("Bash(git:*)")).toBeNull();
    expect(validateRulePattern("Read(src/**/*.ts)")).toBeNull();
    expect(validateRulePattern("Bash(ls /foo/*)")).toBeNull();
    expect(validateRulePattern("mcp__echo__echo")).toBeNull();
  });
});

describe("validateRulePattern — grounding for what is and isn't dead", () => {
  test("a bare-server rule with an argPattern really matches, so rejecting it would break it", () => {
    const allow = evaluate([{ tool: "mcp__shell(git:*)", action: "allow" }], {
      toolName: "mcp__shell__run",
      input: { command: "git status" },
    });
    expect(allow.allow).toBe(true);
    expect(allow.matched).toBe(true);

    const deny = evaluate(
      [
        { tool: "mcp__shell(rm:*)", action: "deny" },
        { tool: "mcp__*", action: "allow" },
      ],
      { toolName: "mcp__shell__run", input: { command: "rm -rf /" } },
    );
    expect(deny.allow).toBe(false);
    expect(deny.matched).toBe(true);
  });

  test("a __* wildcard rule with an argPattern is genuinely dead — parsePattern cannot split it", () => {
    expect(parsePattern("mcp__atlassian__*(query:*)")).toEqual({
      tool: "mcp__atlassian__*(query:*)",
      argPattern: null,
    });
    const decision = evaluate([{ tool: "mcp__atlassian__*(query:*)", action: "allow" }], {
      toolName: "mcp__atlassian__search",
      input: { query: "anything" },
    });
    expect(decision.matched).toBe(false);
  });
});

describe("assertValidRules", () => {
  test("passes for valid rules", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Bash(git:*)", action: "allow" },
      { tool: "mcp__atlassian__*", action: "deny" },
      { tool: "mcp__echo(:*)", action: "allow" },
    ];
    expect(() => assertValidRules(rules)).not.toThrow();
  });

  test("throws naming every offending rule", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "mcp__*(foo:*)", action: "allow" },
      { tool: "mcp__echo__*(bar)", action: "deny" },
    ];
    expect(() => assertValidRules(rules)).toThrow(/mcp__\*\(foo:\*\)[\s\S]*mcp__echo__\*\(bar\)/);
  });
});
