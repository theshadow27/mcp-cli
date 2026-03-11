import { describe, expect, it } from "bun:test";
import type { MailMessage } from "@mcp-cli/core";
import type { Key } from "ink";
import { type MailNav, handleMailInput } from "./use-keyboard-mail";

function makeMsg(overrides: Partial<MailMessage> & { id: number }): MailMessage {
  return {
    sender: "alice",
    recipient: "bob",
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
    selectedIndex: 0,
    expandedMessage: null,
    scrollOffset: 0,
  };

  return {
    messages: [makeMsg({ id: 1 }), makeMsg({ id: 2, read: true }), makeMsg({ id: 3 })],
    selectedIndex: (state.selectedIndex as number) ?? 0,
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
    nav.state.selectedIndex = 2;
    handleMailInput("", { ...baseKey, upArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("clamps at top boundary", () => {
    const nav = makeNav();
    nav.state.selectedIndex = 0;
    handleMailInput("", { ...baseKey, upArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(0);
  });

  it("clamps at bottom boundary", () => {
    const nav = makeNav({ selectedIndex: 2 });
    nav.state.selectedIndex = 2;
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
    nav.state.expandedMessage = 1;
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
    const nav = makeNav({ expandedMessage: 1 });
    nav.state.expandedMessage = 1;
    nav.state.scrollOffset = 0;
    handleMailInput("", { ...baseKey, downArrow: true }, nav);
    expect(nav.state.scrollOffset).toBe(1);
  });
});
