import { describe, expect, it } from "bun:test";
import type { MailMessage } from "@mcp-cli/core";
import type { Key } from "ink";
import { type MailNav, handleMailInput } from "./use-keyboard-mail";

function makeMsg(overrides: Partial<MailMessage> & { id: number }): MailMessage {
  return {
    sender: "alice",
    recipient: "human",
    subject: "test",
    body: "hello",
    replyTo: null,
    read: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

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

function makeNav(overrides: Partial<MailNav> = {}): MailNav & { state: Record<string, unknown> } {
  const state: Record<string, unknown> = {
    selectedIndex: overrides.selectedIndex ?? 0,
    expandedMessage: overrides.expandedMessage ?? null,
    scrollOffset: overrides.scrollOffset ?? 0,
  };

  return {
    messages: [makeMsg({ id: 1 }), makeMsg({ id: 2, read: true }), makeMsg({ id: 3 })],
    selectedIndex: state.selectedIndex as number,
    setSelectedIndex: (fn) => {
      state.selectedIndex = fn(state.selectedIndex as number);
    },
    expandedMessage: state.expandedMessage as number | null,
    setExpandedMessage: (id) => {
      state.expandedMessage = id;
    },
    scrollOffset: state.scrollOffset as number,
    setScrollOffset: (fn) => {
      state.scrollOffset = fn(state.scrollOffset as number);
    },
    ipcCallFn: async () => ({}) as never,
    state,
    ...overrides,
  };
}

describe("handleMailInput", () => {
  it("navigates down with j", () => {
    const nav = makeNav();
    const consumed = handleMailInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("navigates down with down arrow", () => {
    const nav = makeNav();
    handleMailInput("", { ...baseKey, downArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("navigates up with up arrow", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handleMailInput("", { ...baseKey, upArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("clamps at top boundary", () => {
    const nav = makeNav();
    handleMailInput("", { ...baseKey, upArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(0);
  });

  it("clamps at bottom boundary", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handleMailInput("", { ...baseKey, downArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(2);
  });

  it("expands message on enter", () => {
    const nav = makeNav();
    handleMailInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedMessage).toBe(1);
  });

  it("collapses message on enter when already expanded", () => {
    const nav = makeNav({ expandedMessage: 1 });
    handleMailInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedMessage).toBeNull();
  });

  it("auto-marks unread message as read on expand", () => {
    const markedIds: number[] = [];
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      markedIds.push(params.id as number);
      return {} as never;
    };

    const nav = makeNav({ ipcCallFn: ipcCallFn as MailNav["ipcCallFn"] });
    handleMailInput("", { ...baseKey, return: true }, nav);
    expect(markedIds).toEqual([1]);
  });

  it("does not mark session-addressed message as read on expand", () => {
    let called = false;
    const ipcCallFn = async () => {
      called = true;
      return {} as never;
    };

    const msgs = [makeMsg({ id: 1, recipient: "session-abc" })];
    const nav = makeNav({ messages: msgs, ipcCallFn: ipcCallFn as MailNav["ipcCallFn"] });
    handleMailInput("", { ...baseKey, return: true }, nav);
    expect(called).toBe(false);
    expect(nav.state.expandedMessage).toBe(1); // still expands, just doesn't mark read
  });

  it("marks wildcard-recipient message as read on expand", () => {
    const markedIds: number[] = [];
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      markedIds.push(params.id as number);
      return {} as never;
    };

    const msgs = [makeMsg({ id: 1, recipient: "*" })];
    const nav = makeNav({ messages: msgs, ipcCallFn: ipcCallFn as MailNav["ipcCallFn"] });
    handleMailInput("", { ...baseKey, return: true }, nav);
    expect(markedIds).toEqual([1]);
  });

  it("does not mark session-addressed message with m key", () => {
    let called = false;
    const ipcCallFn = async () => {
      called = true;
      return {} as never;
    };

    const msgs = [makeMsg({ id: 1, recipient: "session-abc" })];
    const nav = makeNav({ messages: msgs, ipcCallFn: ipcCallFn as MailNav["ipcCallFn"] });
    handleMailInput("m", baseKey, nav);
    expect(called).toBe(false);
  });

  it("does not mark already-read message on expand", () => {
    let called = false;
    const ipcCallFn = async () => {
      called = true;
      return {} as never;
    };

    const msgs = [makeMsg({ id: 1, read: true })];
    const nav = makeNav({ messages: msgs, ipcCallFn: ipcCallFn as MailNav["ipcCallFn"] });
    handleMailInput("", { ...baseKey, return: true }, nav);
    expect(called).toBe(false);
  });

  it("marks message as read with m", () => {
    const markedIds: number[] = [];
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      markedIds.push(params.id as number);
      return {} as never;
    };

    const nav = makeNav({ ipcCallFn: ipcCallFn as MailNav["ipcCallFn"] });
    const consumed = handleMailInput("m", baseKey, nav);
    expect(consumed).toBe(true);
    expect(markedIds).toEqual([1]);
  });

  it("returns false on empty messages", () => {
    const nav = makeNav({ messages: [] });
    const consumed = handleMailInput("j", baseKey, nav);
    expect(consumed).toBe(false);
  });

  it("scrolls in detail view with down arrow", () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const msgs = [makeMsg({ id: 1, body: longBody }), makeMsg({ id: 2, read: true }), makeMsg({ id: 3 })];
    const nav = makeNav({ messages: msgs, expandedMessage: 1, viewHeight: 10 });
    handleMailInput("", { ...baseKey, downArrow: true }, nav);
    expect(nav.state.scrollOffset).toBe(1);
  });

  it("clamps scroll offset at max in detail view", () => {
    // Message with id=1 has body "hello" → ~7 lines total (From, To, Subject, Date, blank, hello)
    // With viewHeight=20, all content fits → maxOffset = 0 → can't scroll past 0
    const nav = makeNav({ expandedMessage: 1, scrollOffset: 0, viewHeight: 20 });
    // Try scrolling down many times
    for (let i = 0; i < 30; i++) {
      handleMailInput("", { ...baseKey, downArrow: true }, nav);
    }
    // Should be clamped, not 30
    expect(nav.state.scrollOffset).toBe(0);
  });

  it("allows scroll within bounds for long messages", () => {
    const longBody = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const msgs = [makeMsg({ id: 1, body: longBody })];
    const nav = makeNav({ messages: msgs, expandedMessage: 1, scrollOffset: 0, viewHeight: 10 });
    // Scroll down a few times
    for (let i = 0; i < 5; i++) {
      handleMailInput("", { ...baseKey, downArrow: true }, nav);
    }
    expect(nav.state.scrollOffset).toBe(5);
    // Scroll way past the end
    for (let i = 0; i < 100; i++) {
      handleMailInput("", { ...baseKey, downArrow: true }, nav);
    }
    // 6 header lines + 50 body lines = 56 total, viewHeight=10 → maxOffset = 46
    expect(nav.state.scrollOffset).toBeLessThanOrEqual(46);
    expect(nav.state.scrollOffset).toBeGreaterThan(0);
  });
});
