import type { MailMessage } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";

export interface MailNav {
  messages: MailMessage[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedMessage: number | null;
  setExpandedMessage: (id: number | null) => void;
  scrollOffset: number;
  setScrollOffset: (fn: (offset: number) => number) => void;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/**
 * Handle keyboard input for the mail view.
 * Returns true if the input was consumed.
 */
export function handleMailInput(input: string, key: Key, nav: MailNav): boolean {
  const { messages, selectedIndex, expandedMessage } = nav;
  const callFn = nav.ipcCallFn ?? ipcCall;

  if (messages.length === 0) return false;

  // Navigate list
  if (key.upArrow || input === "k") {
    if (expandedMessage !== null) {
      nav.setScrollOffset((o) => Math.max(0, o - 1));
    } else {
      nav.setSelectedIndex((i) => Math.max(0, i - 1));
    }
    return true;
  }
  if (key.downArrow || input === "j") {
    if (expandedMessage !== null) {
      nav.setScrollOffset((o) => o + 1);
    } else {
      nav.setSelectedIndex((i) => Math.min(messages.length - 1, i + 1));
    }
    return true;
  }

  // Enter: toggle expand/collapse
  if (key.return) {
    const msg = messages[selectedIndex];
    if (!msg) return false;
    if (expandedMessage === msg.id) {
      nav.setExpandedMessage(null);
      nav.setScrollOffset(() => 0);
    } else {
      nav.setExpandedMessage(msg.id);
      nav.setScrollOffset(() => 0);
      // Auto-mark as read when expanding
      if (!msg.read) {
        callFn("markRead", { id: msg.id }).catch(() => {});
      }
    }
    return true;
  }

  // m: mark selected as read/toggle
  if (input === "m") {
    const msg = messages[selectedIndex];
    if (msg && !msg.read) {
      callFn("markRead", { id: msg.id }).catch(() => {});
    }
    return true;
  }

  return false;
}
