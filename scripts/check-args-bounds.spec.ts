import { describe, expect, test } from "bun:test";
import { isSafe } from "./check-args-bounds";

/**
 * Unit tests for the args bounds lint rule's safety-check logic.
 * We test isSafe() directly rather than spawning the script.
 */

describe("check-args-bounds isSafe()", () => {
  describe("violations (unsafe)", () => {
    test("bare assignment, no check", () => {
      const lines = ["  scope = parseScope(args[++i], CONFIG_SCOPES);"];
      expect(isSafe(lines, 0)).toBe(false);
    });

    test("next line checks a different variable", () => {
      const lines = ["  requestId = args[++i];", "  } else if (!args[i].startsWith('-')) {"];
      expect(isSafe(lines, 0)).toBe(false);
    });

    test("subsequent line is unrelated else-if branch", () => {
      const lines = ["  sourcePath = args[++i];", "  else if (a.startsWith('--source=')) sourcePath = a.slice(9);"];
      expect(isSafe(lines, 0)).toBe(false);
    });

    test("post-check matches longer identifier with same suffix (word-boundary)", () => {
      // 'id' should not match 'requestId === undefined'
      const lines = ["  id = args[++i];", "  if (requestId === undefined) {"];
      expect(isSafe(lines, 0)).toBe(false);
    });

    test("bare args[i + 1] read is not a guard", () => {
      // Reading args[i + 1] into a variable is not a truthy pre-check
      const lines = ["  const next = args[i + 1];", "  val = args[++i];"];
      expect(isSafe(lines, 1)).toBe(false);
    });

    test("?? in a comment is not a null-coalescing guard", () => {
      // Rule 1 must require ?? adjacent to args[++i], not anywhere on the line
      const lines = ["  val = args[++i]; // ?? should this be nullish?"];
      expect(isSafe(lines, 0)).toBe(false);
    });

    test("comment containing i + 1 and args.length is not a bounds guard", () => {
      // Rule 3 must strip inline comments before testing for a bounds comparison
      const lines = ["  // TODO: add i + 1 < args.length check here", "  val = args[++i];"];
      expect(isSafe(lines, 1)).toBe(false);
    });

    test("RHS args[i+1] && expression is not a guard (Rule 2 trailing-operator requires first token)", () => {
      // `const x = args[i + 1] && y` reads args[i+1] into x — no guard on i+1 for the later access
      const lines = ["  const x = args[i + 1] && someCondition;", "  val = args[++i];"];
      expect(isSafe(lines, 1)).toBe(false);
    });

    test("i <= args.length - 1 is not safe (off-by-one: allows i === args.length - 1)", () => {
      // i <= args.length - 1 ≡ i < args.length, so i may equal args.length - 1,
      // making args[++i] === args[args.length] === undefined.
      const lines = ["  if (i <= args.length - 1) {", "    val = args[++i];"];
      expect(isSafe(lines, 1)).toBe(false);
    });
  });

  describe("safe cases", () => {
    test("explicit bounds check 3 lines before", () => {
      const lines = ["  if (i + 1 >= args.length) {", "    d.exit(1);", "  }", "  rawReason = args[++i];"];
      expect(isSafe(lines, 3)).toBe(true);
    });

    test("while condition with i + 1 < args.length", () => {
      const lines = ["  while (i + 1 < args.length && looksLikeToolName(args[i + 1])) {", "    allow.push(args[++i]);"];
      expect(isSafe(lines, 1)).toBe(true);
    });

    test("null coalescing on same line", () => {
      const lines = ["  from = args[++i] ?? null;"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("truthy pre-check on preceding line", () => {
      const lines = ["  if (arg === '--cloud-id' && args[i + 1]) {", "    cloudId = args[++i];"];
      expect(isSafe(lines, 1)).toBe(true);
    });

    test("post-check: if (!val) after const assignment", () => {
      const lines = ["  const val = args[++i];", "  if (!val) {"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("post-check: if (!subscribe) after assignment", () => {
      const lines = ["  subscribe = args[++i];", "  if (!subscribe) {"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("post-check: if (val === undefined)", () => {
      const lines = ["  const val = args[++i];", "  if (val === undefined) {"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("post-check: if (val === null)", () => {
      const lines = ["  const val = args[++i];", "  if (val === null) {"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("post-check: if (val == null)", () => {
      const lines = ["  const val = args[++i];", "  if (val == null) {"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("bounds check exactly 6 lines before (boundary)", () => {
      const lines = [
        "  if (i + 1 >= args.length) throw new Error();",
        "  // comment 1",
        "  // comment 2",
        "  // comment 3",
        "  // comment 4",
        "  // comment 5",
        "  val = args[++i];",
      ];
      expect(isSafe(lines, 6)).toBe(true);
    });

    test("truthy pre-check on same line via args[i + 1]", () => {
      const lines = ["  if (args[i + 1]) val = args[++i];"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("same-line ternary bounds check", () => {
      // Rule 3 must include the current line (j <= lineIdx) to catch this pattern
      const lines = ["  val = i + 1 < args.length ? args[++i] : null;"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    // Rule 2 extension: multi-line if block (issue #1967)
    test("truthy pre-check 3 lines above (multi-line if block)", () => {
      const lines = ["  if (", "    args[i + 1] &&", "    someCondition", "  ) {", "    val = args[++i];"];
      expect(isSafe(lines, 4)).toBe(true);
    });

    test("truthy pre-check exactly 6 lines above (boundary)", () => {
      const lines = [
        "  if (args[i + 1] &&",
        "    a &&",
        "    b &&",
        "    c &&",
        "    d) {",
        "  // comment",
        "    val = args[++i];",
      ];
      expect(isSafe(lines, 6)).toBe(true);
    });

    // Rule 3 extension: algebraic equivalents (issue #1969)
    test("i < args.length - 1 guard on preceding line", () => {
      const lines = ["  if (i < args.length - 1) {", "    val = args[++i];"];
      expect(isSafe(lines, 1)).toBe(true);
    });

    test("args.length - 1 > i guard on preceding line", () => {
      const lines = ["  if (args.length - 1 > i) {", "    val = args[++i];"];
      expect(isSafe(lines, 1)).toBe(true);
    });

    // Escape hatch (issue #1968)
    test("inline suppression with reason", () => {
      const lines = ["  val = args[++i]; // lint-allow-args-bounds: helper verifies bounds internally"];
      expect(isSafe(lines, 0)).toBe(true);
    });

    test("inline suppression with reason in comment-only position", () => {
      const lines = ["  val = customHelper(args, ++i); // lint-allow-args-bounds: wrapper checks bounds"];
      // ACCESS_PATTERN won't match this (no args[++i]) but isSafe should still return true
      // because the marker is present (defensive: safe if called)
      expect(isSafe(lines, 0)).toBe(true);
    });
  });

  describe("suppression escape hatch violations", () => {
    test("bare suppression marker without reason is not a guard", () => {
      // No text after the colon — should NOT be treated as suppressed
      const lines = ["  val = args[++i]; // lint-allow-args-bounds:"];
      expect(isSafe(lines, 0)).toBe(false);
    });

    test("suppression marker with only whitespace after colon is not a guard", () => {
      const lines = ["  val = args[++i]; // lint-allow-args-bounds:   "];
      expect(isSafe(lines, 0)).toBe(false);
    });
  });
});
