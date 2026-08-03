import { describe, expect, test } from "bun:test";
import { type PermissionRule, assertValidRules, validateRulePattern } from "./rule";

describe("validateRulePattern", () => {
  test("rejects argPattern on an explicit tool wildcard", () => {
    const error = validateRulePattern("mcp__atlassian__*(query:*)");
    expect(error).toContain('Invalid permission rule "mcp__atlassian__*(query:*)"');
    expect(error).toContain("mcp__atlassian__*");
    expect(error).toContain("JSON input");
  });

  test("rejects argPattern on mcp__*", () => {
    expect(validateRulePattern("mcp__*(foo)")).not.toBeNull();
  });

  test("rejects argPattern on a bare MCP server pattern", () => {
    expect(validateRulePattern("mcp__atlassian(query:*)")).not.toBeNull();
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

describe("assertValidRules", () => {
  test("passes for valid rules", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Bash(git:*)", action: "allow" },
      { tool: "mcp__atlassian__*", action: "deny" },
    ];
    expect(() => assertValidRules(rules)).not.toThrow();
  });

  test("throws naming every offending rule", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "mcp__*(foo:*)", action: "allow" },
      { tool: "mcp__echo(bar)", action: "deny" },
    ];
    expect(() => assertValidRules(rules)).toThrow(/mcp__\*\(foo:\*\)[\s\S]*mcp__echo\(bar\)/);
  });
});
