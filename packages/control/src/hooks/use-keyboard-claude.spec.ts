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
    transcriptScrollOffset: 0,
    setTranscriptScrollOffset: mock(() => {}),
    transcriptViewHeight: 15,
    promptMode: false,
    setPromptMode: mock(() => {}),
    promptText: "",
    setPromptText: mock(() => {}),
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

describe("handleClaudeInput prompt mode", () => {
  test("p enters prompt mode when session selected", () => {
    const nav = makeNav();
    const consumed = handleClaudeInput("p", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptMode).toHaveBeenCalledWith(true);
  });

  test("p does nothing when no sessions", () => {
    const nav = makeNav({ sessions: [] as unknown as ClaudeNav["sessions"] });
    const consumed = handleClaudeInput("p", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptMode).not.toHaveBeenCalled();
  });

  test("captures text input in prompt mode", () => {
    const nav = makeNav({ promptMode: true });
    const consumed = handleClaudeInput("h", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptText).toHaveBeenCalled();
  });

  test("backspace deletes last char in prompt mode", () => {
    const nav = makeNav({ promptMode: true, promptText: "abc" });
    const consumed = handleClaudeInput("", { ...baseKey, backspace: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptText).toHaveBeenCalled();
  });

  test("escape cancels prompt mode", () => {
    const nav = makeNav({ promptMode: true, promptText: "test" });
    const consumed = handleClaudeInput("", { ...baseKey, escape: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptText).toHaveBeenCalledWith("");
    expect(nav.setPromptMode).toHaveBeenCalledWith(false);
  });

  test("Enter sends prompt and exits mode", () => {
    const nav = makeNav({ promptMode: true, promptText: "do something" });
    const consumed = handleClaudeInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptText).toHaveBeenCalledWith("");
    expect(nav.setPromptMode).toHaveBeenCalledWith(false);
  });

  test("Enter with empty text does not send", () => {
    const nav = makeNav({ promptMode: true, promptText: "" });
    const consumed = handleClaudeInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    // Still exits mode
    expect(nav.setPromptMode).toHaveBeenCalledWith(false);
  });

  test("ignores ctrl+key combos in prompt mode", () => {
    const nav = makeNav({ promptMode: true });
    const consumed = handleClaudeInput("c", { ...baseKey, ctrl: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setPromptText).not.toHaveBeenCalled();
  });
});

describe("handleClaudeInput transcript navigation (expanded session)", () => {
  const entries: ClaudeNav["transcriptEntries"] = [
    { direction: "outbound", timestamp: 1, message: { role: "user", content: "a" } },
    { direction: "inbound", timestamp: 2, message: { role: "assistant", content: "b" } },
  ];

  test("left arrow collapses expanded session", () => {
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: entries,
      transcriptCursor: "1-outbound",
    });
    const consumed = handleClaudeInput("", { ...baseKey, leftArrow: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setExpandedSession).toHaveBeenCalledWith(null);
    expect(nav.setTranscriptCursor).toHaveBeenCalled();
    expect(nav.setTranscriptScrollOffset).toHaveBeenCalled();
    expect(nav.setExpandedEntries).toHaveBeenCalled();
  });

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

  test("j adjusts scroll offset when cursor moves past viewport", () => {
    // 20 entries, viewport height 3, cursor at entry 2 (index 2), scroll at 0
    const manyEntries = Array.from({ length: 20 }, (_, i) => ({
      direction: "inbound" as const,
      timestamp: i,
      message: { type: "result", result: `entry-${i}` },
    }));
    let scrollResult = -1;
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: manyEntries,
      transcriptCursor: "2-inbound", // at index 2
      transcriptScrollOffset: 0,
      transcriptViewHeight: 3,
      setTranscriptScrollOffset: mock((fn: (o: number) => number) => {
        scrollResult = fn(0);
      }),
    });
    handleClaudeInput("j", baseKey, nav);
    // cursor moves to index 3, which is >= offset(0) + height(3), so scroll should advance
    expect(scrollResult).toBe(1);
  });

  test("k adjusts scroll offset when cursor moves above viewport", () => {
    const manyEntries = Array.from({ length: 20 }, (_, i) => ({
      direction: "inbound" as const,
      timestamp: i,
      message: { type: "result", result: `entry-${i}` },
    }));
    let scrollResult = -1;
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: manyEntries,
      transcriptCursor: "5-inbound", // at index 5
      transcriptScrollOffset: 5,
      transcriptViewHeight: 3,
      setTranscriptScrollOffset: mock((fn: (o: number) => number) => {
        scrollResult = fn(5);
      }),
    });
    handleClaudeInput("k", baseKey, nav);
    // cursor moves to index 4, which is < offset(5), so scroll should move to 4
    expect(scrollResult).toBe(4);
  });

  test("scroll offset unchanged when cursor stays in viewport", () => {
    const manyEntries = Array.from({ length: 20 }, (_, i) => ({
      direction: "inbound" as const,
      timestamp: i,
      message: { type: "result", result: `entry-${i}` },
    }));
    let scrollResult = -1;
    const nav = makeNav({
      expandedSession: "sess-1",
      transcriptEntries: manyEntries,
      transcriptCursor: "1-inbound", // at index 1
      transcriptScrollOffset: 0,
      transcriptViewHeight: 5,
      setTranscriptScrollOffset: mock((fn: (o: number) => number) => {
        scrollResult = fn(0);
      }),
    });
    handleClaudeInput("j", baseKey, nav);
    // cursor moves to index 2, still within viewport [0..5), so no scroll change
    expect(scrollResult).toBe(0);
  });
});
