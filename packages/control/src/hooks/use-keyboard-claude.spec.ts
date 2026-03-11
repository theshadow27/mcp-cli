import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { ClaudeNav } from "./use-keyboard";
import { handleClaudeInput } from "./use-keyboard-claude";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function makeNav(overrides: Partial<ClaudeNav> = {}): ClaudeNav {
  return {
    sessions: [
      {
        sessionId: "sess-1",
        state: "running",
        pendingPermissionDetails: [{ requestId: "req-1", tool: "bash", args: {} }],
      },
    ] as unknown as ClaudeNav["sessions"],
    selectedIndex: 0,
    setSelectedIndex: mock(() => {}),
    expandedSession: null,
    setExpandedSession: mock(() => {}),
    permissionIndex: 0,
    setPermissionIndex: mock(() => {}),
    denyReasonMode: false,
    setDenyReasonMode: mock(() => {}),
    denyReasonText: "",
    setDenyReasonText: mock(() => {}),
    ...overrides,
  };
}

describe("handleClaudeInput", () => {
  test("j moves selection down", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setSelectedIndex).toHaveBeenCalled();
  });

  test("k moves selection up", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("k", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setSelectedIndex).toHaveBeenCalled();
  });

  test("Enter toggles expanded session", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setExpandedSession).toHaveBeenCalled();
  });

  test("a approves permission", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("a", baseKey, nav);
    expect(consumed).toBe(true);
  });

  test("d enters deny reason mode", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("d", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setDenyReasonMode).toHaveBeenCalledWith(true);
  });

  test("x ends session", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("x", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setExpandedSession).toHaveBeenCalledWith(null);
  });

  test("left/right arrow navigates permissions", () => {
    const nav = makeNav();
    expect(handleClaudeInput("", { ...baseKey, leftArrow: true }, nav)).toBe(true);
    expect(nav.setPermissionIndex).toHaveBeenCalled();

    expect(handleClaudeInput("", { ...baseKey, rightArrow: true }, nav)).toBe(true);
  });

  test("unrecognized key returns false", () => {
    const nav = makeNav();
    expect(handleClaudeInput("z", baseKey, nav)).toBe(false);
  });
});

describe("handleClaudeInput deny reason mode", () => {
  test("captures text input", () => {
    const nav = makeNav({ denyReasonMode: true });
    const consumed = handleClaudeInput("h", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setDenyReasonText).toHaveBeenCalled();
  });

  test("backspace deletes last char", () => {
    const nav = makeNav({ denyReasonMode: true, denyReasonText: "abc" });
    const consumed = handleClaudeInput("", { ...baseKey, backspace: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setDenyReasonText).toHaveBeenCalled();
  });

  test("escape cancels deny mode", () => {
    const nav = makeNav({ denyReasonMode: true, denyReasonText: "reason" });
    const consumed = handleClaudeInput("", { ...baseKey, escape: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setDenyReasonText).toHaveBeenCalledWith("");
    expect(nav.setDenyReasonMode).toHaveBeenCalledWith(false);
  });

  test("Enter submits denial", () => {
    const nav = makeNav({ denyReasonMode: true, denyReasonText: "not allowed" });
    const consumed = handleClaudeInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setDenyReasonText).toHaveBeenCalledWith("");
    expect(nav.setDenyReasonMode).toHaveBeenCalledWith(false);
  });

  test("ignores ctrl+key combos", () => {
    const nav = makeNav({ denyReasonMode: true });
    const consumed = handleClaudeInput("c", { ...baseKey, ctrl: true }, nav);
    expect(consumed).toBe(true);
    // setDenyReasonText should not be called with text append
    expect(nav.setDenyReasonText).not.toHaveBeenCalled();
  });
});
