import { describe, expect, test } from "bun:test";
import { DEFAULT_SAFE_TOOLS, looksLikeToolName, resolveEffectiveTools, validateAllowPatterns } from "./allow-patterns";

// ── DEFAULT_SAFE_TOOLS ──

describe("DEFAULT_SAFE_TOOLS", () => {
  test("contains the expected safe tools", () => {
    expect(DEFAULT_SAFE_TOOLS).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_SAFE_TOOLS)).toBe(true);
  });
});

// ── looksLikeToolName ──

describe("looksLikeToolName", () => {
  test("accepts PascalCase names", () => {
    expect(looksLikeToolName("Read")).toBe(true);
    expect(looksLikeToolName("WebSearch")).toBe(true);
  });

  test("accepts wildcards", () => {
    expect(looksLikeToolName("*")).toBe(true);
    expect(looksLikeToolName("Bash*")).toBe(true);
  });

  test("accepts mcp-style names", () => {
    expect(looksLikeToolName("mcp__echo__add")).toBe(true);
  });

  test("rejects lowercase identifiers", () => {
    expect(looksLikeToolName("my-worktree")).toBe(false);
    expect(looksLikeToolName("codex-wt1")).toBe(false);
  });

  test("rejects flags", () => {
    expect(looksLikeToolName("--task")).toBe(false);
    expect(looksLikeToolName("-t")).toBe(false);
  });
});

// ── validateAllowPatterns ──

describe("validateAllowPatterns", () => {
  test("passes through simple patterns", () => {
    const result = validateAllowPatterns(["Read", "Bash"]);
    expect(result.patterns).toEqual(["Read", "Bash"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("splits comma-separated patterns", () => {
    const result = validateAllowPatterns(["Bash,Write,Read"]);
    expect(result.patterns).toEqual(["Bash", "Write", "Read"]);
  });

  test("warns on comma-separated patterns", () => {
    const result = validateAllowPatterns(["Bash,Write"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Comma-separated");
  });

  test("handles mixed comma and individual patterns", () => {
    const result = validateAllowPatterns(["Read", "Bash,Write"]);
    expect(result.patterns).toEqual(["Read", "Bash", "Write"]);
  });

  test("ignores empty segments in comma-separated patterns", () => {
    const result = validateAllowPatterns(["Bash,,Write,"]);
    expect(result.patterns).toEqual(["Bash", "Write"]);
  });

  test("errors on Bash(*) dead pattern", () => {
    const result = validateAllowPatterns(["Bash(*)"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("dead rule");
    expect(result.errors[0]).toContain('Use "Bash"');
  });

  test("errors on Write(*) dead pattern", () => {
    const result = validateAllowPatterns(["Write(*)"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("dead rule");
  });

  test("warns on Bash(git*) missing colon wildcard", () => {
    const result = validateAllowPatterns(["Bash(git*)"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("may not match");
    expect(result.warnings[0]).toContain(":*");
  });

  test("no warning on valid Bash(git:*) pattern", () => {
    const result = validateAllowPatterns(["Bash(git:*)"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("no warning on bare tool name", () => {
    const result = validateAllowPatterns(["Bash"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("no warning on exact command pattern", () => {
    const result = validateAllowPatterns(["Bash(bun test)"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("detects multiple dead patterns", () => {
    const result = validateAllowPatterns(["Bash(*)", "Write(*)"]);
    expect(result.errors).toHaveLength(2);
  });
});

// ── resolveEffectiveTools ──

describe("resolveEffectiveTools", () => {
  test("returns undefined when permissionMode is not rules", () => {
    const result = resolveEffectiveTools({ permissionMode: "auto" });
    expect(result.tools).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test("returns DEFAULT_SAFE_TOOLS when no allowedTools", () => {
    const result = resolveEffectiveTools({ permissionMode: "rules" });
    expect(result.tools).toEqual([...DEFAULT_SAFE_TOOLS]);
  });

  test("unions allowedTools with DEFAULT_SAFE_TOOLS by default", () => {
    const result = resolveEffectiveTools({
      allowedTools: ["Bash"],
      permissionMode: "rules",
    });
    expect(result.tools).toContain("Bash");
    expect(result.tools).toContain("Read");
    expect(result.tools).toContain("Write");
  });

  test("deduplicates when allowedTools overlaps defaults", () => {
    const result = resolveEffectiveTools({
      allowedTools: ["Read", "Bash"],
      permissionMode: "rules",
    });
    const readCount = result.tools?.filter((t) => t === "Read").length;
    expect(readCount).toBe(1);
  });

  test("allowOnly=true uses exactly the provided tools", () => {
    const result = resolveEffectiveTools({
      allowedTools: ["Bash"],
      allowOnly: true,
      permissionMode: "rules",
    });
    expect(result.tools).toEqual(["Bash"]);
    expect(result.error).toBeUndefined();
  });

  test("allowOnly=true with no allowedTools returns error", () => {
    const result = resolveEffectiveTools({
      allowOnly: true,
      permissionMode: "rules",
    });
    expect(result.error).toBeDefined();
    expect(result.tools).toEqual([]);
  });

  test("allowOnly=true with empty allowedTools returns error", () => {
    const result = resolveEffectiveTools({
      allowedTools: [],
      allowOnly: true,
      permissionMode: "rules",
    });
    expect(result.error).toBeDefined();
    expect(result.tools).toEqual([]);
  });

  test("defaults permissionMode to rules", () => {
    const result = resolveEffectiveTools({});
    expect(result.tools).toEqual([...DEFAULT_SAFE_TOOLS]);
  });
});
