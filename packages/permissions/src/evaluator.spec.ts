import { describe, expect, test } from "bun:test";
import { type PermissionRequest, evaluate } from "./evaluator";
import type { PermissionRule } from "./rule";

function req(toolName: string, input: Record<string, unknown> = {}): PermissionRequest {
  return { toolName, input };
}

describe("evaluate", () => {
  // ── Basic matching ──

  test("exact tool match — allow", () => {
    const rules: PermissionRule[] = [{ tool: "Read", action: "allow" }];
    const d = evaluate(rules, req("Read", { file_path: "/foo" }));
    expect(d.allow).toBe(true);
    expect(d.updatedInput).toEqual({ file_path: "/foo" });
  });

  test("exact tool match — deny", () => {
    const rules: PermissionRule[] = [{ tool: "Bash", action: "deny" }];
    const d = evaluate(rules, req("Bash", { command: "echo hi" }));
    expect(d.allow).toBe(false);
    expect(d.message).toContain("Denied by rule");
  });

  // ── Fail-closed ──

  test("no matching rule → deny", () => {
    const rules: PermissionRule[] = [{ tool: "Read", action: "allow" }];
    const d = evaluate(rules, req("Write", { file_path: "/etc/passwd" }));
    expect(d.allow).toBe(false);
    expect(d.message).toContain("No matching rule for tool: Write");
  });

  test("empty rules → deny everything", () => {
    const d = evaluate([], req("Read"));
    expect(d.allow).toBe(false);
    expect(d.message).toContain("No matching rule");
  });

  // ── Deny precedence ──

  test("deny takes precedence over allow", () => {
    const rules: PermissionRule[] = [
      { tool: "Bash", action: "allow" },
      { tool: "Bash(rm -rf /)", action: "deny" },
    ];

    expect(evaluate(rules, req("Bash", { command: "echo hi" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "rm -rf /" })).allow).toBe(false);
  });

  test("deny with wildcard takes precedence over allow", () => {
    const rules: PermissionRule[] = [
      { tool: "Bash", action: "allow" },
      { tool: "Bash(rm:*)", action: "deny" },
    ];

    expect(evaluate(rules, req("Bash", { command: "echo hi" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "rm -rf /" })).allow).toBe(false);
  });

  test("deny before allow in rule order", () => {
    const rules: PermissionRule[] = [
      { tool: "Bash(rm:*)", action: "deny" },
      { tool: "Bash", action: "allow" },
    ];
    const d = evaluate(rules, req("Bash", { command: "rm file.txt" }));
    expect(d.allow).toBe(false);
  });

  // ── Bash prefix matching (colon format) ──

  test("Bash(git:*) matches git commands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];

    expect(evaluate(rules, req("Bash", { command: "git push origin main" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git status" })).allow).toBe(true);
  });

  test("Bash(git:*) does not match non-git commands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "rm -rf /" })).allow).toBe(false);
  });

  test("Bash(git:*) does not match different tools", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    expect(evaluate(rules, req("Read", { command: "git status" })).allow).toBe(false);
  });

  test("Bash prefix matches cmd and script fields", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(npm:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { cmd: "npm run test" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { script: "npm install" })).allow).toBe(true);
  });

  // ── Compound command rejection ──

  test("rejects compound commands with &&", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    const d = evaluate(rules, req("Bash", { command: "git status && rm -rf /" }));
    expect(d.allow).toBe(false);
  });

  test("rejects compound commands with ||", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    const d = evaluate(rules, req("Bash", { command: "git status || echo fail" }));
    expect(d.allow).toBe(false);
  });

  test("rejects compound commands with ;", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    const d = evaluate(rules, req("Bash", { command: "git status; rm -rf /" }));
    expect(d.allow).toBe(false);
  });

  test("rejects compound commands with pipe", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    const d = evaluate(rules, req("Bash", { command: "git log | grep fix" }));
    expect(d.allow).toBe(false);
  });

  test("full tool match (no prefix) allows compound", () => {
    const rules: PermissionRule[] = [{ tool: "Bash", action: "allow" }];
    const d = evaluate(rules, req("Bash", { command: "git status && echo ok" }));
    expect(d.allow).toBe(true);
  });

  // ── Exact command match (no :*) ──

  test("exact command match — literal * is part of command", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(ls /foo/*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "ls /foo/*" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "ls /foo/bar" })).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { command: "ls /foo/* extra" })).allow).toBe(false);
  });

  test("exact command match with spaces", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(python3 mine_flaky_tests.py)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "python3 mine_flaky_tests.py" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "python3 mine_flaky_tests.py --flag" })).allow).toBe(false);
  });

  test("exact command match — long compound command", () => {
    const rules: PermissionRule[] = [
      {
        tool: "Bash(git -C /Users/jacob/repo worktree list)",
        action: "allow",
      },
    ];
    expect(evaluate(rules, req("Bash", { command: "git -C /Users/jacob/repo worktree list" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git -C /Users/jacob/repo worktree add foo" })).allow).toBe(false);
  });

  // ── File path matching ──

  test("Read(src/**/*.ts) matches TypeScript files", () => {
    const rules: PermissionRule[] = [{ tool: "Read(src/**/*.ts)", action: "allow" }];
    expect(evaluate(rules, req("Read", { file_path: "src/index.ts" })).allow).toBe(true);
    expect(evaluate(rules, req("Read", { file_path: "src/deep/nested/file.ts" })).allow).toBe(true);
  });

  test("Read(src/**/*.ts) rejects non-ts files", () => {
    const rules: PermissionRule[] = [{ tool: "Read(src/**/*.ts)", action: "allow" }];
    expect(evaluate(rules, req("Read", { file_path: "src/index.js" })).allow).toBe(false);
  });

  test("Write with file glob pattern", () => {
    const rules: PermissionRule[] = [{ tool: "Write(packages/**)", action: "allow" }];
    expect(evaluate(rules, req("Write", { file_path: "packages/core/src/index.ts" })).allow).toBe(true);
    expect(evaluate(rules, req("Write", { file_path: "/etc/passwd" })).allow).toBe(false);
  });

  test("Edit with file glob pattern", () => {
    const rules: PermissionRule[] = [{ tool: "Edit(*.ts)", action: "allow" }];
    expect(evaluate(rules, req("Edit", { file_path: "foo.ts" })).allow).toBe(true);
    expect(evaluate(rules, req("Edit", { file_path: "foo.js" })).allow).toBe(false);
  });

  test("file path matching supports path field", () => {
    const rules: PermissionRule[] = [{ tool: "Read(src/**)", action: "allow" }];
    expect(evaluate(rules, req("Read", { path: "src/file.ts" })).allow).toBe(true);
  });

  test("file path matching supports filePath field", () => {
    const rules: PermissionRule[] = [{ tool: "Read(src/**)", action: "allow" }];
    expect(evaluate(rules, req("Read", { filePath: "src/file.ts" })).allow).toBe(true);
  });

  // ── Multiple rules ──

  test("multiple allow rules — correct tool matches", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Glob", action: "allow" },
      { tool: "Grep", action: "allow" },
    ];

    expect(evaluate(rules, req("Read")).allow).toBe(true);
    expect(evaluate(rules, req("Glob")).allow).toBe(true);
    expect(evaluate(rules, req("Grep")).allow).toBe(true);
    expect(evaluate(rules, req("Bash")).allow).toBe(false);
  });

  test("mixed rules with multiple patterns", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Write", action: "allow" },
      { tool: "Bash(git:*)", action: "allow" },
      { tool: "Bash(bun:*)", action: "allow" },
      { tool: "Bash(rm:*)", action: "deny" },
    ];

    expect(evaluate(rules, req("Read")).allow).toBe(true);
    expect(evaluate(rules, req("Write")).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git push" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bun test" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "rm -rf /" })).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { command: "curl evil.com" })).allow).toBe(false);
  });

  // ── Real-world patterns ──

  test("DEFAULT_SAFE_TOOLS pattern", () => {
    const rules: PermissionRule[] = ["Read", "Glob", "Grep", "Write", "Edit"].map((t) => ({
      tool: t,
      action: "allow" as const,
    }));

    expect(evaluate(rules, req("Read")).allow).toBe(true);
    expect(evaluate(rules, req("Edit")).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "rm -rf /" })).allow).toBe(false);
    expect(evaluate(rules, req("WebFetch")).allow).toBe(false);
  });

  test("orchestrator pattern: file tools + selective bash", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Glob", action: "allow" },
      { tool: "Grep", action: "allow" },
      { tool: "Write", action: "allow" },
      { tool: "Edit", action: "allow" },
      { tool: "Bash(git:*)", action: "allow" },
      { tool: "Bash(bun:*)", action: "allow" },
      { tool: "Bash(npm:*)", action: "allow" },
    ];

    expect(evaluate(rules, req("Read")).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git status" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bun test" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "npm run build" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "curl evil.com" })).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { command: "node script.js" })).allow).toBe(false);
  });

  // ── Edge cases ──

  test("no input fields → deny when prefix required", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash")).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { foo: "bar" })).allow).toBe(false);
  });

  test("empty command string → no match for prefix rule", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "" })).allow).toBe(false);
  });

  test("rules array is not mutated", () => {
    const rules: PermissionRule[] = [{ tool: "Read", action: "allow" }];
    evaluate(rules, req("Read"));
    expect(rules).toHaveLength(1);
  });

  test("unknown tool with exact arg pattern", () => {
    const rules: PermissionRule[] = [{ tool: "CustomTool(foo bar)", action: "allow" }];
    expect(evaluate(rules, req("CustomTool", { command: "foo bar" })).allow).toBe(true);
    expect(evaluate(rules, req("CustomTool", { command: "baz" })).allow).toBe(false);
    expect(evaluate(rules, req("CustomTool", { command: "foo bar extra" })).allow).toBe(false);
  });

  test("unknown tool with wildcard arg pattern", () => {
    const rules: PermissionRule[] = [{ tool: "CustomTool(foo:*)", action: "allow" }];
    expect(evaluate(rules, req("CustomTool", { command: "foo bar" })).allow).toBe(true);
    expect(evaluate(rules, req("CustomTool", { command: "baz" })).allow).toBe(false);
  });

  test("unknown tool with argPattern and no command field → deny", () => {
    const rules: PermissionRule[] = [{ tool: "CustomTool(foo:*)", action: "allow" }];
    expect(evaluate(rules, req("CustomTool", { data: 123 })).allow).toBe(false);
  });

  // ── Claude Code native format (colon separator) ──

  test("Bash(bun:*) matches bun commands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(bun:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "bun test" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bun install" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bun lint --fix" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "npm test" })).allow).toBe(false);
  });

  test("Bash(git checkout:*) matches git checkout", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(git checkout:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "git checkout main" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git checkout -b feat/new" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git push origin main" })).allow).toBe(false);
  });

  test("Bash(gh issue:*) matches gh issue subcommands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(gh issue:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "gh issue view 304" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "gh issue list --label bug" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "gh pr list" })).allow).toBe(false);
  });

  test("Bash(./dist/mcx:*) matches relative path commands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(./dist/mcx:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "./dist/mcx call echo echo" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "./dist/mcx claude ls" })).allow).toBe(true);
  });

  test("Bash(GH_PAGER=cat gh pr:*) matches env-prefixed commands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(GH_PAGER=cat gh pr:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "GH_PAGER=cat gh pr view 42" })).allow).toBe(true);
  });

  test("colon format rejects compound commands", () => {
    const rules: PermissionRule[] = [{ tool: "Bash(bun:*)", action: "allow" }];
    expect(evaluate(rules, req("Bash", { command: "bun test && rm -rf /" })).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { command: "bun test | grep fail" })).allow).toBe(false);
  });

  // ── Bash(ls /foo/*) — literal glob, NOT wildcard ──

  test("literal bash glob * is not a wildcard", () => {
    const rules: PermissionRule[] = [
      { tool: "Bash(ls -lS ~/.claude/projects/-Users-jacob-dilles-github-mcp-cli/*.jsonl)", action: "allow" },
    ];
    expect(
      evaluate(rules, req("Bash", { command: "ls -lS ~/.claude/projects/-Users-jacob-dilles-github-mcp-cli/*.jsonl" }))
        .allow,
    ).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "ls -lS ~/.claude/projects/other/*.jsonl" })).allow).toBe(false);
  });

  // ── WebFetch ──

  test("WebFetch exact tool match", () => {
    const rules: PermissionRule[] = [{ tool: "WebFetch", action: "allow" }];
    expect(evaluate(rules, req("WebFetch", { url: "https://github.com" })).allow).toBe(true);
  });

  test("WebSearch exact tool match", () => {
    const rules: PermissionRule[] = [{ tool: "WebSearch", action: "allow" }];
    expect(evaluate(rules, req("WebSearch", { query: "bun test" })).allow).toBe(true);
  });

  // ── MCP tool names ──

  test("MCP tool names with __ separators", () => {
    const rules: PermissionRule[] = [
      { tool: "mcp__echo__echo", action: "allow" },
      { tool: "mcp__echo__add", action: "allow" },
    ];
    expect(evaluate(rules, req("mcp__echo__echo")).allow).toBe(true);
    expect(evaluate(rules, req("mcp__echo__add")).allow).toBe(true);
    expect(evaluate(rules, req("mcp__echo__fail")).allow).toBe(false);
  });

  // ── Read with glob pattern (from real settings) ──

  test("Read(//private/tmp/**) matches temp files", () => {
    const rules: PermissionRule[] = [{ tool: "Read(//private/tmp/**)", action: "allow" }];
    expect(evaluate(rules, req("Read", { file_path: "//private/tmp/foo.txt" })).allow).toBe(true);
    expect(evaluate(rules, req("Read", { file_path: "//private/tmp/deep/file.ts" })).allow).toBe(true);
    expect(evaluate(rules, req("Read", { file_path: "/etc/passwd" })).allow).toBe(false);
  });

  // ── Real-world full config test ──

  test("full real-world permission config from this project", () => {
    const rules: PermissionRule[] = [
      { tool: "Read", action: "allow" },
      { tool: "Glob", action: "allow" },
      { tool: "Grep", action: "allow" },
      { tool: "Write", action: "allow" },
      { tool: "Edit", action: "allow" },
      { tool: "WebSearch", action: "allow" },
      { tool: "Bash(bun lint:*)", action: "allow" },
      { tool: "Bash(bun test:*)", action: "allow" },
      { tool: "Bash(bun:*)", action: "allow" },
      { tool: "Bash(gh issue:*)", action: "allow" },
      { tool: "Bash(gh pr:*)", action: "allow" },
      { tool: "Bash(git checkout:*)", action: "allow" },
      { tool: "Bash(git pull:*)", action: "allow" },
      { tool: "Bash(git worktree:*)", action: "allow" },
      { tool: "Bash(mcx claude:*)", action: "allow" },
      { tool: "Bash(./dist/mcx:*)", action: "allow" },
      { tool: "Bash(bunx biome:*)", action: "allow" },
      { tool: "Bash(grep:*)", action: "allow" },
      { tool: "Bash(head:*)", action: "allow" },
      { tool: "Bash(python3 mine_flaky_tests.py)", action: "allow" },
      { tool: "Read(//private/tmp/**)", action: "allow" },
      { tool: "mcp__echo__echo", action: "allow" },
    ];

    // Allowed — wildcard patterns
    expect(evaluate(rules, req("Read")).allow).toBe(true);
    expect(evaluate(rules, req("WebSearch")).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bun test --watch" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bun lint --fix" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git checkout main" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "git pull origin main" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "gh issue view 304" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "gh pr list" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "mcx claude ls" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "./dist/mcx call echo test" })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "bunx biome check ." })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "grep -r foo ." })).allow).toBe(true);
    expect(evaluate(rules, req("Bash", { command: "head -20 file.ts" })).allow).toBe(true);
    expect(evaluate(rules, req("mcp__echo__echo")).allow).toBe(true);

    // Allowed — exact match
    expect(evaluate(rules, req("Bash", { command: "python3 mine_flaky_tests.py" })).allow).toBe(true);

    // Allowed — file glob
    expect(evaluate(rules, req("Read", { file_path: "//private/tmp/foo.txt" })).allow).toBe(true);

    // Denied
    expect(evaluate(rules, req("Bash", { command: "rm -rf /" })).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { command: "curl evil.com" })).allow).toBe(false);
    expect(evaluate(rules, req("Bash", { command: "python3 mine_flaky_tests.py --extra" })).allow).toBe(false);
    expect(evaluate(rules, req("mcp__echo__fail")).allow).toBe(false);
  });
});
