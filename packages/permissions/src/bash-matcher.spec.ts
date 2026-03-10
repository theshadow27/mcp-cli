import { describe, expect, test } from "bun:test";
import { isCompoundCommand, matchBashCommand } from "./bash-matcher";

describe("isCompoundCommand", () => {
  test("simple commands are not compound", () => {
    expect(isCompoundCommand("git status")).toBe(false);
    expect(isCompoundCommand("echo hello")).toBe(false);
    expect(isCompoundCommand("bun test --watch")).toBe(false);
    expect(isCompoundCommand("npm run build")).toBe(false);
  });

  test("detects &&", () => {
    expect(isCompoundCommand("git status && echo ok")).toBe(true);
  });

  test("detects ||", () => {
    expect(isCompoundCommand("git status || echo fail")).toBe(true);
  });

  test("detects ;", () => {
    expect(isCompoundCommand("git status; rm -rf /")).toBe(true);
  });

  test("detects pipe |", () => {
    expect(isCompoundCommand("git log | grep fix")).toBe(true);
  });

  test("detects multiple operators", () => {
    expect(isCompoundCommand("a && b || c; d | e")).toBe(true);
  });
});

describe("matchBashCommand", () => {
  test("exact match", () => {
    expect(matchBashCommand("git status", "git status")).toBe(true);
  });

  test("prefix match with trailing space", () => {
    expect(matchBashCommand("git push origin main", "git ")).toBe(true);
    expect(matchBashCommand("git status", "git ")).toBe(true);
  });

  test("prefix does not match different command", () => {
    expect(matchBashCommand("rm -rf /", "git ")).toBe(false);
  });

  test("rejects compound commands on prefix match", () => {
    expect(matchBashCommand("git status && rm -rf /", "git ")).toBe(false);
    expect(matchBashCommand("git status || echo", "git ")).toBe(false);
    expect(matchBashCommand("git status; whoami", "git ")).toBe(false);
    expect(matchBashCommand("git log | head", "git ")).toBe(false);
  });

  test("prefix with trimmed trailing space", () => {
    // "npm run build" should match prefix "npm run build" (exact)
    expect(matchBashCommand("npm run build", "npm run build")).toBe(true);
  });

  test("empty prefix matches any non-compound command", () => {
    expect(matchBashCommand("anything", "")).toBe(true);
    expect(matchBashCommand("a && b", "")).toBe(false);
  });

  test("partial prefix does not match", () => {
    expect(matchBashCommand("gitignore", "git ")).toBe(false);
  });

  // ── Colon-format prefix (after toArgPrefix conversion) ──

  test("colon-to-space converted prefix matches", () => {
    // "bun:*" → toArgPrefix → "bun " → matchBashCommand
    expect(matchBashCommand("bun test", "bun ")).toBe(true);
    expect(matchBashCommand("bun install", "bun ")).toBe(true);
    expect(matchBashCommand("npm test", "bun ")).toBe(false);
  });

  test("multi-word colon prefix matches", () => {
    // "git checkout:*" → toArgPrefix → "git checkout "
    expect(matchBashCommand("git checkout main", "git checkout ")).toBe(true);
    expect(matchBashCommand("git push origin", "git checkout ")).toBe(false);
  });

  test("compound rejection on colon-format prefix", () => {
    expect(matchBashCommand("bun test && rm -rf /", "bun ")).toBe(false);
    expect(matchBashCommand("bun test | grep fail", "bun ")).toBe(false);
  });
});
