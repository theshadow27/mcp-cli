import { describe, expect, it } from "bun:test";
import { looksLikeToolName, parseSharedSpawnArgs } from "./spawn-args";

describe("parseSharedSpawnArgs", () => {
  it("parses --task flag", () => {
    const result = parseSharedSpawnArgs(["--task", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  it("parses -t shorthand", () => {
    const result = parseSharedSpawnArgs(["-t", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  it("treats positional arg as task", () => {
    const result = parseSharedSpawnArgs(["fix the tests"]);
    expect(result.task).toBe("fix the tests");
  });

  it("prefers --task over positional", () => {
    const result = parseSharedSpawnArgs(["--task", "from flag", "positional"]);
    expect(result.task).toBe("from flag");
  });

  it("parses --allow with multiple tools", () => {
    const result = parseSharedSpawnArgs(["--allow", "Read", "Glob", "Grep", "--task", "x"]);
    expect(result.allow).toEqual(["Read", "Glob", "Grep"]);
  });

  it("parses --cwd", () => {
    const result = parseSharedSpawnArgs(["--cwd", "/tmp/work", "--task", "x"]);
    expect(result.cwd).toBe("/tmp/work");
  });

  it("parses --timeout", () => {
    const result = parseSharedSpawnArgs(["--timeout", "60000", "--task", "x"]);
    expect(result.timeout).toBe(60000);
  });

  it("parses --model with shortname resolution", () => {
    const result = parseSharedSpawnArgs(["--model", "sonnet", "--task", "x"]);
    expect(result.model).toContain("sonnet");
  });

  it("parses -m shorthand", () => {
    const result = parseSharedSpawnArgs(["-m", "haiku", "-t", "x"]);
    expect(result.model).toContain("haiku");
  });

  it("parses --wait flag", () => {
    const result = parseSharedSpawnArgs(["--task", "fix bug", "--wait"]);
    expect(result.wait).toBe(true);
  });

  it("defaults wait to false", () => {
    const result = parseSharedSpawnArgs(["--task", "fix bug"]);
    expect(result.wait).toBe(false);
  });

  it("errors on missing --task value", () => {
    const result = parseSharedSpawnArgs(["--task"]);
    expect(result.error).toBe("--task requires a value");
  });

  it("errors on missing --cwd value", () => {
    const result = parseSharedSpawnArgs(["--cwd"]);
    expect(result.error).toBe("--cwd requires a path");
  });

  it("errors on missing --timeout value", () => {
    const result = parseSharedSpawnArgs(["--timeout"]);
    expect(result.error).toBe("--timeout requires a value in ms");
  });

  it("errors on non-numeric --timeout", () => {
    const result = parseSharedSpawnArgs(["--timeout", "abc"]);
    expect(result.error).toBe("--timeout must be a number");
  });

  it("errors on missing --model value", () => {
    const result = parseSharedSpawnArgs(["--model"]);
    expect(result.error).toBe("--model requires a value");
  });

  it("errors on empty --allow", () => {
    const result = parseSharedSpawnArgs(["--allow", "--task", "x"]);
    expect(result.error).toBe("--allow requires at least one tool pattern");
  });

  it("calls extra handler for provider-specific flags", () => {
    let sawCustom = false;
    const result = parseSharedSpawnArgs(["--custom", "--task", "x"], (arg) => {
      if (arg === "--custom") {
        sawCustom = true;
        return 0;
      }
      return undefined;
    });
    expect(sawCustom).toBe(true);
    expect(result.task).toBe("x");
  });

  it("extra handler can consume next arg", () => {
    let customValue: string | undefined;
    const result = parseSharedSpawnArgs(["--custom", "val", "--task", "x"], (arg, allArgs, i) => {
      if (arg === "--custom") {
        customValue = allArgs[i + 1];
        return 1;
      }
      return undefined;
    });
    expect(customValue).toBe("val");
    expect(result.task).toBe("x");
  });

  it("passes full model ID through unchanged", () => {
    const result = parseSharedSpawnArgs(["--model", "claude-opus-4-6", "--task", "x"]);
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("--allow stops consuming at lowercase positional (worktree name)", () => {
    const result = parseSharedSpawnArgs(["--allow", "Read", "Write", "my-worktree"]);
    expect(result.allow).toEqual(["Read", "Write"]);
    // "my-worktree" should be treated as task (positional), not consumed by --allow
    expect(result.task).toBe("my-worktree");
  });

  it("--allow accepts wildcard patterns", () => {
    const result = parseSharedSpawnArgs(["--allow", "Read", "*", "--task", "x"]);
    expect(result.allow).toEqual(["Read", "*"]);
  });

  it("--allow accepts mcp-style tool names", () => {
    const result = parseSharedSpawnArgs(["--allow", "mcp__echo__add", "Read", "--task", "x"]);
    expect(result.allow).toEqual(["mcp__echo__add", "Read"]);
  });
});

describe("looksLikeToolName", () => {
  it("accepts PascalCase names", () => {
    expect(looksLikeToolName("Read")).toBe(true);
    expect(looksLikeToolName("WebSearch")).toBe(true);
  });

  it("accepts wildcards", () => {
    expect(looksLikeToolName("*")).toBe(true);
    expect(looksLikeToolName("Bash*")).toBe(true);
  });

  it("accepts mcp-style names", () => {
    expect(looksLikeToolName("mcp__echo__add")).toBe(true);
  });

  it("rejects lowercase identifiers (worktree/session names)", () => {
    expect(looksLikeToolName("my-worktree")).toBe(false);
    expect(looksLikeToolName("codex-wt1")).toBe(false);
    expect(looksLikeToolName("abc12345")).toBe(false);
  });

  it("rejects flags", () => {
    expect(looksLikeToolName("--task")).toBe(false);
    expect(looksLikeToolName("-t")).toBe(false);
  });
});
