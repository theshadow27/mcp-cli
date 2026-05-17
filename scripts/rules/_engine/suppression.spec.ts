import { describe, expect, it } from "bun:test";

import { checkSuppression } from "./suppression";

describe("checkSuppression", () => {
  it("matches dotw-ignore on the same line", () => {
    const src = ["execSync(`foo ${bar}`); // dotw-ignore shell-injection: trusted input"].join("\n");
    expect(checkSuppression(src, 1, "shell-injection")).toEqual({
      suppressed: true,
      todoWithoutIssue: false,
      kind: "ignore",
    });
  });

  it("matches dotw-ignore on the preceding line", () => {
    const src = ["// dotw-ignore shell-injection: trusted input", "badCall(payload);"].join("\n");
    expect(checkSuppression(src, 2, "shell-injection").suppressed).toBe(true);
  });

  it("does not match when the rule id differs", () => {
    const src = ["// dotw-ignore other-rule: x", "badCall(payload);"].join("\n");
    expect(checkSuppression(src, 2, "shell-injection").suppressed).toBe(false);
  });

  it("dotw-todo with #<number> is suppressed, no flag", () => {
    const src = ["// dotw-todo shell-injection: refactor needed — fix in #1234", "badCall(payload);"].join("\n");
    const m = checkSuppression(src, 2, "shell-injection");
    expect(m.suppressed).toBe(true);
    expect(m.kind).toBe("todo");
    expect(m.todoWithoutIssue).toBe(false);
  });

  it("dotw-todo without #<number> is flagged for a meta-rule", () => {
    const src = ["// dotw-todo shell-injection: refactor needed soon", "badCall(payload);"].join("\n");
    const m = checkSuppression(src, 2, "shell-injection");
    expect(m.suppressed).toBe(true);
    expect(m.todoWithoutIssue).toBe(true);
  });

  it("ignores comments two or more lines above the violation", () => {
    const src = ["// dotw-ignore shell-injection: too far", "", "badCall(payload);"].join("\n");
    expect(checkSuppression(src, 3, "shell-injection").suppressed).toBe(false);
  });
});
