import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainmentGuard, gateContainment } from "@mcp-cli/core";
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

  test("normalizes OpenCode's `file` metadata key to the guard-native `file_path`", () => {
    const result = mapPermissionRequest({
      id: "perm-2b",
      permission: "write",
      patterns: ["/foo/bar.ts"],
      metadata: { file: "/foo/bar.ts" },
    });
    expect(result.input.file_path).toBe("/foo/bar.ts");
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

// ── Containment contract (#2519, #2720) ──
// Drives the adapter's REAL metadata shape through the shared ContainmentGuard.
// This is the test that would have caught the file/file_path key mismatch:
// the guard fail-closes on any write whose real path it can't resolve.
describe("opencode adapter → ContainmentGuard contract", () => {
  test("a write inside the worktree (real `file` key) resolves to allow", () => {
    const wt = mkdtempSync(join(tmpdir(), "oc-contract-"));
    try {
      const guard = new ContainmentGuard(wt);
      const perm = mapPermissionRequest({
        id: "c1",
        permission: "write",
        patterns: [],
        metadata: { file: join(wt, "ok.ts") },
      });
      const result = gateContainment(guard, perm.toolName, perm.input, () => {});
      expect(result?.action).toBe("allow");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a write outside the worktree (real `file` key) is denied", () => {
    const wt = mkdtempSync(join(tmpdir(), "oc-contract-"));
    try {
      const guard = new ContainmentGuard(wt);
      const perm = mapPermissionRequest({
        id: "c2",
        permission: "write",
        patterns: [],
        metadata: { file: "/etc/oc-contract-escape.txt" },
      });
      const result = gateContainment(guard, perm.toolName, perm.input, () => {});
      expect(result?.action).toBe("deny");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a bash command (real `command` key) escaping the worktree is denied", () => {
    const wt = mkdtempSync(join(tmpdir(), "oc-contract-"));
    try {
      const guard = new ContainmentGuard(wt);
      const perm = mapPermissionRequest({
        id: "c3",
        permission: "bash",
        patterns: [],
        metadata: { command: "git -C /etc commit -m pwned" },
      });
      const result = gateContainment(guard, perm.toolName, perm.input, () => {});
      expect(result?.action).toBe("deny");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
