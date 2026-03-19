import { describe, expect, test } from "bun:test";
import { buildRules, evaluatePermission, findOptionId, mapPermissionRequest } from "./acp-permission-adapter";
import type { PermissionRequestParams } from "./schemas";

describe("mapPermissionRequest", () => {
  test("maps command permission to Bash tool", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      tool: "Bash",
      command: "npm test",
      description: "Run npm test",
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    };
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Bash");
    expect(result.input).toEqual({ command: "npm test" });
    expect(result.inputSummary).toBe("Run npm test");
  });

  test("maps file permission to Write tool", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      path: "/foo/bar.ts",
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    };
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Write");
    expect(result.input).toEqual({ file_path: "/foo/bar.ts" });
  });

  test("falls back to unknown tool when no context", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    };
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("unknown");
  });
});

describe("evaluatePermission", () => {
  test("no rules → unresolved", () => {
    const permission = { requestId: "1", toolName: "Bash", input: { command: "ls" }, inputSummary: "ls" };
    const decision = evaluatePermission(permission, []);
    expect(decision.resolved).toBe(false);
  });

  test("matching allow rule → resolved + allow", () => {
    const rules = buildRules(["Bash"]);
    const permission = { requestId: "1", toolName: "Bash", input: { command: "ls" }, inputSummary: "ls" };
    const decision = evaluatePermission(permission, rules);
    expect(decision.resolved).toBe(true);
    expect(decision.allow).toBe(true);
    expect(decision.persistent).toBe(true);
  });

  test("matching deny rule → resolved + deny", () => {
    const rules = buildRules(undefined, ["Bash"]);
    const permission = { requestId: "1", toolName: "Bash", input: { command: "rm -rf /" }, inputSummary: "rm" };
    const decision = evaluatePermission(permission, rules);
    expect(decision.resolved).toBe(true);
    expect(decision.allow).toBe(false);
  });

  test("deny takes precedence over allow", () => {
    const rules = buildRules(["Bash"], ["Bash"]);
    const permission = { requestId: "1", toolName: "Bash", input: { command: "ls" }, inputSummary: "ls" };
    const decision = evaluatePermission(permission, rules);
    expect(decision.resolved).toBe(true);
    expect(decision.allow).toBe(false);
  });
});

describe("buildRules", () => {
  test("deny rules come before allow rules", () => {
    const rules = buildRules(["Read"], ["Bash"]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ tool: "Bash", action: "deny" });
    expect(rules[1]).toEqual({ tool: "Read", action: "allow" });
  });

  test("empty inputs produce empty rules", () => {
    expect(buildRules()).toHaveLength(0);
    expect(buildRules([], [])).toHaveLength(0);
  });
});

describe("findOptionId", () => {
  const options = [
    { optionId: "opt-allow-once", kind: "allow_once" },
    { optionId: "opt-allow-always", kind: "allow_always" },
    { optionId: "opt-reject", kind: "reject_once" },
  ];

  test("finds matching kind", () => {
    expect(findOptionId(options, "allow_always")).toBe("opt-allow-always");
    expect(findOptionId(options, "reject_once")).toBe("opt-reject");
  });

  test("returns undefined for missing kind", () => {
    expect(findOptionId(options, "reject_always")).toBeUndefined();
  });
});
