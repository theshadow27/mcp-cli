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
    transcriptCursor: null,
    setTranscriptCursor: mock(() => {}),
    transcriptEntries: [],
    expandedEntries: new Set(),
    setExpandedEntries: mock(() => {}),
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

  test("j clamps to 0 when sessions list is empty", () => {
    let result = -1;
    const nav = makeNav({
      sessions: [] as unknown as ClaudeNav["sessions"],
      selectedIndex: 0,
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(0);
      }),
    });
    handleClaudeInput("j", baseKey, nav);
    expect(result).toBe(0); // must not go to -1
  });

  test("j advances index by 1", () => {
    let result = -1;
    const nav = makeNav({
      sessions: [
        { sessionId: "s1", state: "running", pendingPermissionDetails: [] },
        { sessionId: "s2", state: "running", pendingPermissionDetails: [] },
      ] as unknown as ClaudeNav["sessions"],
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(0);
      }),
    });
    handleClaudeInput("j", baseKey, nav);
    expect(result).toBe(1);
  });

  test("k clamps at 0", () => {
    let result = -1;
    const nav = makeNav({
      selectedIndex: 0,
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(0);
      }),
    });
    handleClaudeInput("k", baseKey, nav);
    expect(result).toBe(0);
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

describe("handleClaudeInput transcript navigation (expanded session)", () => {
  const entries: ClaudeNav["transcriptEntries"] = [
    { direction: "outbound", timestamp: 1, message: { role: "user", content: "a" } },
    { direction: "inbound", timestamp: 2, message: { role: "assistant", content: "b" } },
  ];

  test("j moves transcript cursor down", () => {
    let result: string | null = null;
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: entries,
      transcriptCursor: null,
      setTranscriptCursor: mock((fn: (prev: string | null) => string | null) => {
        result = fn(null);
      }),
    });
    const consumed = handleClaudeInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(result).not.toBeNull();
  });

  test("k moves transcript cursor up", () => {
    let result: string | null = null;
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: entries,
      transcriptCursor: null,
      setTranscriptCursor: mock((fn: (prev: string | null) => string | null) => {
        result = fn(null);
      }),
    });
    const consumed = handleClaudeInput("k", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setTranscriptCursor).toHaveBeenCalled();
  });

  test("Enter toggles expanded entry when cursor set", () => {
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: entries,
      transcriptCursor: `${entries[0].timestamp}-${entries[0].direction}`,
      setExpandedEntries: mock(() => {}),
    });
    const consumed = handleClaudeInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setExpandedEntries).toHaveBeenCalled();
  });

  test("Enter is no-op when no cursor", () => {
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: entries,
      transcriptCursor: null,
    });
    const consumed = handleClaudeInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setExpandedEntries).not.toHaveBeenCalled();
  });
});
