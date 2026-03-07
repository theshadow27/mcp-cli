import { describe, expect, test } from "bun:test";
import {
  type CanUseToolRequest,
  type PermissionDecision,
  PermissionRouter,
  type PermissionRule,
} from "./permission-router";

// ── Fixtures ──

function makeRequest(toolName: string, input: Record<string, unknown> = {}): CanUseToolRequest {
  return {
    subtype: "can_use_tool",
    tool_name: toolName,
    input,
    tool_use_id: "tu-1",
  };
}

// ── auto strategy ──

describe("PermissionRouter — auto", () => {
  const router = new PermissionRouter("auto");

  test("approves any tool", async () => {
    const decision = await router.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
    expect(decision.allow).toBe(true);
    expect(decision.updatedInput).toEqual({ command: "rm -rf /" });
  });

  test("approves tools with no input", async () => {
    const decision = await router.evaluate(makeRequest("Read"));
    expect(decision.allow).toBe(true);
  });
});

// ── rules strategy ──

describe("PermissionRouter — rules", () => {
  test("exact match allow", async () => {
    const router = new PermissionRouter("rules", [{ tool: "Read", action: "allow" }]);
    const decision = await router.evaluate(makeRequest("Read", { file_path: "/foo" }));

    expect(decision.allow).toBe(true);
    expect(decision.updatedInput).toEqual({ file_path: "/foo" });
  });

  test("exact match deny", async () => {
    const router = new PermissionRouter("rules", [{ tool: "Bash", action: "deny" }]);
    const decision = await router.evaluate(makeRequest("Bash", { command: "echo hi" }));

    expect(decision.allow).toBe(false);
    expect(decision.message).toContain("Denied by rule");
  });

  test("glob pattern with args — Bash(git *) matches git commands", async () => {
    const router = new PermissionRouter("rules", [{ tool: "Bash(git *)", action: "allow" }]);

    const gitPush = await router.evaluate(makeRequest("Bash", { command: "git push origin main" }));
    expect(gitPush.allow).toBe(true);

    const gitStatus = await router.evaluate(makeRequest("Bash", { command: "git status" }));
    expect(gitStatus.allow).toBe(true);
  });

  test("glob pattern does not match different commands", async () => {
    const router = new PermissionRouter("rules", [{ tool: "Bash(git *)", action: "allow" }]);

    const rm = await router.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
    expect(rm.allow).toBe(false);
    expect(rm.message).toContain("No matching rule");
  });

  test("glob pattern does not match different tools", async () => {
    const router = new PermissionRouter("rules", [{ tool: "Bash(git *)", action: "allow" }]);

    const read = await router.evaluate(makeRequest("Read", { command: "git status" }));
    expect(read.allow).toBe(false);
  });

  test("deny takes precedence over allow", async () => {
    const rules: PermissionRule[] = [
      { tool: "Bash", action: "allow" },
      { tool: "Bash(rm *)", action: "deny" },
    ];
    const router = new PermissionRouter("rules", rules);

    // General bash is allowed
    const echo = await router.evaluate(makeRequest("Bash", { command: "echo hi" }));
    expect(echo.allow).toBe(true);

    // rm commands are denied (deny rule matches + takes precedence)
    const rm = await router.evaluate(makeRequest("Bash", { command: "rm -rf /" }));
    expect(rm.allow).toBe(false);
    expect(rm.message).toContain("Denied by rule");
  });

  test("fail-closed: no matching rule denies", async () => {
    const router = new PermissionRouter("rules", [{ tool: "Read", action: "allow" }]);

    const decision = await router.evaluate(makeRequest("Write", { file_path: "/etc/passwd" }));
    expect(decision.allow).toBe(false);
    expect(decision.message).toContain("No matching rule for tool: Write");
  });

  test("empty rules denies everything", async () => {
    const router = new PermissionRouter("rules", []);

    const decision = await router.evaluate(makeRequest("Read"));
    expect(decision.allow).toBe(false);
    expect(decision.message).toContain("No matching rule");
  });

  test("no rules argument denies everything", async () => {
    const router = new PermissionRouter("rules");

    const decision = await router.evaluate(makeRequest("Bash", { command: "ls" }));
    expect(decision.allow).toBe(false);
  });

  test("multiple allow rules — first match wins", async () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Glob", action: "allow" },
      { tool: "Grep", action: "allow" },
    ];
    const router = new PermissionRouter("rules", rules);

    expect((await router.evaluate(makeRequest("Read"))).allow).toBe(true);
    expect((await router.evaluate(makeRequest("Glob"))).allow).toBe(true);
    expect((await router.evaluate(makeRequest("Grep"))).allow).toBe(true);
    expect((await router.evaluate(makeRequest("Bash"))).allow).toBe(false);
  });
});

// ── delegate strategy ──

describe("PermissionRouter — delegate", () => {
  test("invokes callback and returns decision", async () => {
    const router = new PermissionRouter("delegate");
    const expectedDecision: PermissionDecision = {
      allow: true,
      updatedInput: { command: "safe-command" },
    };

    router.onDelegate = async (_req) => expectedDecision;

    const decision = await router.evaluate(makeRequest("Bash", { command: "something" }));
    expect(decision).toEqual(expectedDecision);
  });

  test("passes request to callback", async () => {
    const router = new PermissionRouter("delegate");
    let receivedRequest: CanUseToolRequest | undefined;

    router.onDelegate = async (req) => {
      receivedRequest = req;
      return { allow: true };
    };

    const request = makeRequest("Bash", { command: "echo hi" });
    await router.evaluate(request);

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest).toEqual(request);
  });

  test("denies when no callback registered", async () => {
    const router = new PermissionRouter("delegate");

    const decision = await router.evaluate(makeRequest("Bash"));
    expect(decision.allow).toBe(false);
    expect(decision.message).toContain("No delegate callback");
  });

  test("callback can return deny with message", async () => {
    const router = new PermissionRouter("delegate");
    router.onDelegate = async () => ({
      allow: false,
      message: "Human says no",
    });

    const decision = await router.evaluate(makeRequest("Write"));
    expect(decision.allow).toBe(false);
    expect(decision.message).toBe("Human says no");
  });

  test("callback can return updatedPermissions", async () => {
    const router = new PermissionRouter("delegate");
    router.onDelegate = async (req) => ({
      allow: true,
      updatedInput: req.input,
      updatedPermissions: [{ tool: "Bash(git *)", action: "allow" as const }],
    });

    const decision = await router.evaluate(makeRequest("Bash", { command: "git push" }));
    expect(decision.allow).toBe(true);
    expect(decision.updatedPermissions).toEqual([{ tool: "Bash(git *)", action: "allow" }]);
  });
});

// ── Edge cases ──

describe("PermissionRouter — edge cases", () => {
  test("rules are frozen (immutable)", async () => {
    const rules: PermissionRule[] = [{ tool: "Read", action: "allow" }];
    const router = new PermissionRouter("rules", rules);

    // Mutating original array doesn't affect router
    rules.push({ tool: "Bash", action: "allow" });

    // Router still only has the original rule
    const decision = await router.evaluate(makeRequest("Bash"));
    expect(decision.allow).toBe(false);
  });

  test("strategy is readable", () => {
    expect(new PermissionRouter("auto").strategy).toBe("auto");
    expect(new PermissionRouter("rules").strategy).toBe("rules");
    expect(new PermissionRouter("delegate").strategy).toBe("delegate");
  });
});
