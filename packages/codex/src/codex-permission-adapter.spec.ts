import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPermissionRequest } from "@mcp-cli/core";
import { ContainmentGuard } from "@mcp-cli/core";
import { buildRules, evaluateApproval, gateApprovalContainment } from "./codex-permission-adapter";

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

// ── Containment contract (#2519, #2720) ──
// A codex fileChange patch carries every changed path in `input.files`.
// gateApprovalContainment must validate ALL of them, not just files[0].
describe("gateApprovalContainment", () => {
  test("null guard → null (no worktree, no gating)", () => {
    const result = gateApprovalContainment(null, writeRequest("/anywhere.ts"), () => {});
    expect(result).toBeNull();
  });

  test("multi-file patch fully inside the worktree → allow", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-contract-"));
    try {
      const guard = new ContainmentGuard(wt);
      const perm = writeRequest(join(wt, "a.ts"), [join(wt, "a.ts"), join(wt, "b.ts")]);
      const result = gateApprovalContainment(guard, perm, () => {});
      expect(result?.action).toBe("allow");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("multi-file patch escaping only in a LATER file → deny", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-contract-"));
    const events: string[] = [];
    try {
      const guard = new ContainmentGuard(wt);
      // files[0] inside, files[1] escapes — the exact #2519 bypass.
      const perm = writeRequest(join(wt, "a.ts"), [join(wt, "a.ts"), "/etc/codex-contract-escape.txt"]);
      const result = gateApprovalContainment(guard, perm, (e) => events.push(e.type));
      expect(result?.action).toBe("deny");
      expect(events).toContain("session:containment_denied");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("empty change set fails closed (no synthesized path)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-contract-"));
    try {
      const guard = new ContainmentGuard(wt);
      const result = gateApprovalContainment(guard, writeRequest("unknown", []), () => {});
      expect(result?.action).toBe("deny");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("command-execution approval (no files[]) gates via the Bash path", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-contract-"));
    try {
      const guard = new ContainmentGuard(wt);
      const result = gateApprovalContainment(guard, bashRequest("git -C /etc commit -m pwned"), () => {});
      expect(result?.action).toBe("deny");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
