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

  test("maps a path-only flat permission with no command to Write", () => {
    // The `params.command ? "Bash" : params.path ? "Write"` ladder — path branch.
    const params: PermissionRequestParams = {
      sessionId: "s1",
      path: "/tmp/out.txt",
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    };
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Write");
    expect(result.input).toEqual({ file_path: "/tmp/out.txt" });
    // Summary falls back to the path when no description/command is present.
    expect(result.inputSummary).toBe("/tmp/out.txt");
  });
});

describe("mapPermissionRequest — kiro shape (_meta.kiro / toolCall)", () => {
  test("maps kiro shell capability to Bash with the command as input", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc-1", title: "Run tests" },
      _meta: { kiro: { toolId: "run_command", command: "bun test", consent: { capability: "shell" } } },
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Bash");
    expect(result.input).toEqual({ command: "bun test" });
    expect(result.inputSummary).toBe("Run tests");
  });

  test("maps kiro fsWrite capability to Write with the resource as file_path", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc-2", title: "Write file" },
      _meta: { kiro: { toolId: "fs_write", consent: { capability: "fsWrite", resource: "/repo/a.ts" } } },
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Write");
    expect(result.input).toEqual({ file_path: "/repo/a.ts" });
  });

  test("maps kiro fsRead capability to Read with the resource as file_path", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc-3", title: "Read file" },
      _meta: { kiro: { toolId: "fs_read", consent: { capability: "fsRead", resource: "/repo/b.ts" } } },
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Read");
    expect(result.input).toEqual({ file_path: "/repo/b.ts" });
  });

  test("maps execute_bash toolId (no capability) to Bash", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      _meta: { kiro: { toolId: "execute_bash", command: "ls -la" } },
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Bash");
    expect(result.input).toEqual({ command: "ls -la" });
  });

  test("maps write_file / read_file toolIds without a capability", () => {
    const write = mapPermissionRequest({
      sessionId: "s1",
      _meta: { kiro: { toolId: "write_file", consent: { resource: "/w.ts" } } },
      options: [],
    } as unknown as PermissionRequestParams);
    expect(write.toolName).toBe("Write");
    expect(write.input).toEqual({ file_path: "/w.ts" });

    const read = mapPermissionRequest({
      sessionId: "s1",
      _meta: { kiro: { toolId: "read_file", consent: { resource: "/r.ts" } } },
      options: [],
    } as unknown as PermissionRequestParams);
    expect(read.toolName).toBe("Read");
    expect(read.input).toEqual({ file_path: "/r.ts" });
  });

  test("unknown kiro toolId falls back to the toolId itself, exposing command for a bare rule", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      _meta: { kiro: { toolId: "grep_search", command: "grep foo" } },
      options: [{ optionId: "opt-1", kind: "allow_once" }],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    // Falls back to the raw toolId so an explicit `--allow grep_search` rule matches.
    expect(result.toolName).toBe("grep_search");
    // Unknown/other tool still surfaces the command so a bare tool-name rule matches.
    expect(result.input).toEqual({ command: "grep foo" });
  });

  test("kiro request with neither capability nor toolId maps to unknown", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc-x", title: "Mystery" },
      _meta: { kiro: {} },
      options: [],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("unknown");
    // command falls back to toolCall.title; the unknown-tool branch surfaces it as
    // input.command so a bare tool-name rule can still match.
    expect(result.input).toEqual({ command: "Mystery" });
    expect(result.inputSummary).toBe("Mystery");
  });

  test("kiro Bash without a command leaves input empty (no command key)", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      _meta: { kiro: { toolId: "run_command", consent: { capability: "shell" } } },
      options: [],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Bash");
    expect(result.input).toEqual({});
    // Summary falls back to `kiro <toolId>` when no title/command/resource exists.
    expect(result.inputSummary).toBe("kiro run_command");
  });

  test("kiro summary falls back to command when toolCall.title is absent", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      _meta: { kiro: { toolId: "run_command", command: "echo hi", consent: { capability: "shell" } } },
      options: [],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.inputSummary).toBe("echo hi");
  });

  test("toolCall-only shape (no _meta.kiro) still routes through the kiro mapper", () => {
    // `kiro || params.toolCall` — the toolCall-present branch with no _meta.
    const params: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc-9", title: "Some tool" },
      options: [],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    // No kiro capability/toolId → unknown, summary from the toolCall title.
    expect(result.toolName).toBe("unknown");
    expect(result.inputSummary).toBe("Some tool");
  });

  test("kiro command falls back to toolCall.title when _meta has no command", () => {
    const params: PermissionRequestParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "tc-10", title: "cargo build" },
      _meta: { kiro: { toolId: "run_command", consent: { capability: "shell" } } },
      options: [],
    } as unknown as PermissionRequestParams;
    const result = mapPermissionRequest(params);
    expect(result.toolName).toBe("Bash");
    // command is undefined in _meta → uses toolCall.title as the command.
    expect(result.input).toEqual({ command: "cargo build" });
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

  // Enforcement point for #1702 — a `__*` wildcard carrying an argument pattern is a
  // dead rule and must be rejected here rather than silently denying at match time.
  test("rejects a tool-wildcard rule carrying an argument pattern", () => {
    expect(() => buildRules(["mcp__atlassian__*(query:*)"])).toThrow(/Invalid permission rule/);
  });

  test("rejects a dead wildcard pattern in disallowedTools too", () => {
    expect(() => buildRules(undefined, ["mcp__*(rm:*)"])).toThrow(/Invalid permission rule/);
  });

  test("accepts the bare-server form, which does match via the command fallback", () => {
    expect(() => buildRules(["mcp__echo(:*)"])).not.toThrow();
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
