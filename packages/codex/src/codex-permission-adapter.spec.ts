import { describe, expect, test } from "bun:test";
import type { AgentPermissionRequest } from "@mcp-cli/core";
import { buildRules, evaluateApproval } from "./codex-permission-adapter";

function bashRequest(command: string): AgentPermissionRequest {
  return {
    requestId: "test-1",
    toolName: "Bash",
    input: { command },
    inputSummary: `Run: ${command}`,
  };
}

function writeRequest(filePath: string, files?: string[]): AgentPermissionRequest {
  return {
    requestId: "test-2",
    toolName: "Write",
    input: { file_path: filePath, files: files ?? [filePath] },
    inputSummary: `Write: ${filePath}`,
  };
}

describe("evaluateApproval", () => {
  test("bash command matched by exact rule", () => {
    const rules = buildRules(["Bash(npm test)"]);
    const result = evaluateApproval(bashRequest("npm test"), rules);
    expect(result.resolved).toBe(true);
    expect(result.allow).toBe(true);
  });

  test("bash command matched by wildcard rule", () => {
    const rules = buildRules(["Bash(npm:*)"]);
    const result = evaluateApproval(bashRequest("npm run build"), rules);
    expect(result.resolved).toBe(true);
    expect(result.allow).toBe(true);
  });

  test("bash command denied by deny rule", () => {
    const rules = buildRules(["Bash(git:*)"], ["Bash(rm:*)"]);
    const result = evaluateApproval(bashRequest("rm -rf /"), rules);
    expect(result.resolved).toBe(true);
    expect(result.allow).toBe(false);
  });

  test("bash command not matched — escalated to manual review", () => {
    const rules = buildRules(["Bash(git:*)"]);
    const result = evaluateApproval(bashRequest("curl evil.com"), rules);
    expect(result.resolved).toBe(false);
    expect(result.allow).toBe(false);
  });

  test("bash compound command rejected by wildcard rule — escalated", () => {
    const rules = buildRules(["Bash(git:*)"]);
    const result = evaluateApproval(bashRequest("git status && rm -rf /"), rules);
    expect(result.resolved).toBe(false);
    expect(result.allow).toBe(false);
  });

  test("file path matched by glob rule", () => {
    const rules = buildRules(["Write(src/**/*.ts)"]);
    const result = evaluateApproval(writeRequest("src/codex/session.ts"), rules);
    expect(result.resolved).toBe(true);
    expect(result.allow).toBe(true);
  });

  test("file path not matched — escalated to manual review", () => {
    const rules = buildRules(["Write(src/**/*.ts)"]);
    const result = evaluateApproval(writeRequest("/etc/passwd"), rules);
    expect(result.resolved).toBe(false);
    expect(result.allow).toBe(false);
  });

  test("bare tool allow matches all", () => {
    const rules = buildRules(["Bash"]);
    const result = evaluateApproval(bashRequest("anything at all"), rules);
    expect(result.resolved).toBe(true);
    expect(result.allow).toBe(true);
  });

  test("no rules — unresolved", () => {
    const result = evaluateApproval(bashRequest("npm test"), []);
    expect(result.resolved).toBe(false);
    expect(result.allow).toBe(false);
  });

  test("deny takes precedence over allow", () => {
    const rules = buildRules(["Bash"], ["Bash(rm:*)"]);
    expect(evaluateApproval(bashRequest("git status"), rules).allow).toBe(true);
    expect(evaluateApproval(bashRequest("rm -rf /"), rules).allow).toBe(false);
  });
});

describe("buildRules", () => {
  test("builds allow rules", () => {
    const rules = buildRules(["Read", "Bash(git:*)"]);
    expect(rules).toEqual([
      { tool: "Read", action: "allow" },
      { tool: "Bash(git:*)", action: "allow" },
    ]);
  });

  test("builds deny rules before allow rules", () => {
    const rules = buildRules(["Bash"], ["Bash(rm:*)"]);
    expect(rules).toEqual([
      { tool: "Bash(rm:*)", action: "deny" },
      { tool: "Bash", action: "allow" },
    ]);
  });

  test("handles undefined inputs", () => {
    expect(buildRules()).toEqual([]);
    expect(buildRules(undefined, undefined)).toEqual([]);
  });
});
