import { describe, expect, it } from "bun:test";
import type { MailMessage } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { MailViewer } from "./mail-viewer";

function makeMsg(overrides: Partial<MailMessage> & { id: number }): MailMessage {
  return {
    sender: "alice",
    recipient: "bob",
    subject: "test subject",
    body: "hello world",
    replyTo: null,
    read: false,
    createdAt: "2026-03-11T12:00:00Z",
    ...overrides,
  };
}

describe("MailViewer", () => {
  it("shows empty state when no messages", () => {
    const { lastFrame } = render(
      React.createElement(MailViewer, {
        messages: [],
        selectedIndex: 0,
        expandedMessage: null,
        scrollOffset: 0,
      }),
    );
    expect(lastFrame()).toContain("No messages");
  });

  it("renders message list with sender and subject", () => {
    const msgs = [
      makeMsg({ id: 1, sender: "alice", subject: "hello" }),
      makeMsg({ id: 2, sender: "bob", subject: "world", read: true }),
    ];

    const { lastFrame } = render(
      React.createElement(MailViewer, {
        messages: msgs,
        selectedIndex: 0,
        expandedMessage: null,
        scrollOffset: 0,
      }),
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("alice");
    expect(frame).toContain("hello");
    expect(frame).toContain("bob");
    expect(frame).toContain("world");
  });

  it("shows unread count in header", () => {
    const msgs = [makeMsg({ id: 1 }), makeMsg({ id: 2, read: true }), makeMsg({ id: 3 })];

    const { lastFrame } = render(
      React.createElement(MailViewer, {
        messages: msgs,
        selectedIndex: 0,
        expandedMessage: null,
        scrollOffset: 0,
      }),
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("3 messages");
    expect(frame).toContain("2 unread");
  });

  it("renders message detail when expanded", () => {
    const msg = makeMsg({ id: 1, sender: "alice", subject: "hello", body: "This is the body." });

    const { lastFrame } = render(
      React.createElement(MailViewer, {
        messages: [msg],
        selectedIndex: 0,
        expandedMessage: 1,
        scrollOffset: 0,
      }),
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("From:    alice");
    expect(frame).toContain("Subject: hello");
    expect(frame).toContain("This is the body.");
  });

  it("shows N flag for unread messages", () => {
    const msgs = [makeMsg({ id: 1, read: false }), makeMsg({ id: 2, read: true })];

    const { lastFrame } = render(
      React.createElement(MailViewer, {
        messages: msgs,
        selectedIndex: 0,
        expandedMessage: null,
        scrollOffset: 0,
      }),
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("N");
  });
});
