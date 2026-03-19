import { describe, expect, test } from "bun:test";
import { buildRules, evaluatePermission, mapPermissionRequest } from "./opencode-permission-adapter";

describe("mapPermissionRequest", () => {
  test("maps bash permission to Bash tool", () => {
    const result = mapPermissionRequest({
      id: "perm-1",
      permission: "bash",
      patterns: ["npm test"],
      metadata: { command: "npm test" },
    });
    expect(result.toolName).toBe("Bash");
    expect(result.input).toEqual({ command: "npm test" });
    expect(result.inputSummary).toBe("bash: npm test");
  });

  test("maps edit permission to Write tool", () => {
    const result = mapPermissionRequest({
      id: "perm-2",
      permission: "edit",
      patterns: ["/foo/bar.ts"],
      metadata: { file: "/foo/bar.ts" },
    });
    expect(result.toolName).toBe("Write");
  });

  test("maps read permission to Read tool", () => {
    const result = mapPermissionRequest({
      id: "perm-3",
      permission: "read",
      patterns: [],
      metadata: {},
    });
    expect(result.toolName).toBe("Read");
  });

  test("maps write permission to Write tool", () => {
    const result = mapPermissionRequest({
      id: "perm-4",
      permission: "write",
      patterns: [],
      metadata: {},
    });
    expect(result.toolName).toBe("Write");
  });

  test("maps grep permission to Grep tool", () => {
    const result = mapPermissionRequest({
      id: "perm-5",
      permission: "grep",
      patterns: [],
      metadata: {},
    });
    expect(result.toolName).toBe("Grep");
  });

  test("maps webfetch permission to WebFetch tool", () => {
    const result = mapPermissionRequest({
      id: "perm-6",
      permission: "webfetch",
      patterns: [],
      metadata: {},
    });
    expect(result.toolName).toBe("WebFetch");
  });

  test("capitalizes unknown permissions", () => {
    const result = mapPermissionRequest({
      id: "perm-7",
      permission: "customtool",
      patterns: [],
      metadata: {},
    });
    expect(result.toolName).toBe("Customtool");
  });

  test("summary falls back to permission name when no patterns", () => {
    const result = mapPermissionRequest({
      id: "perm-8",
      permission: "bash",
      patterns: [],
      metadata: {},
    });
    expect(result.inputSummary).toBe("bash request");
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
    expect(decision.reply).toBe("always");
  });

  test("matching deny rule → resolved + deny", () => {
    const rules = buildRules(undefined, ["Bash"]);
    const permission = { requestId: "1", toolName: "Bash", input: { command: "rm -rf /" }, inputSummary: "rm" };
    const decision = evaluatePermission(permission, rules);
    expect(decision.resolved).toBe(true);
    expect(decision.allow).toBe(false);
    expect(decision.reply).toBe("reject");
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
