import { CLAUDE_SERVER_NAME, ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";
import { entryKey } from "../components/claude-session-detail";
import type { ClaudeNav } from "./use-keyboard";

/**
 * Handle keyboard input for the claude view.
 * Returns true if the input was consumed.
 */
export function handleClaudeInput(input: string, key: Key, nav: ClaudeNav): boolean {
  const {
    sessions,
    selectedIndex,
    setSelectedIndex,
    expandedSession,
    setExpandedSession,
    permissionIndex,
    setPermissionIndex,
    denyReasonMode,
    setDenyReasonMode,
    denyReasonText,
    setDenyReasonText,
    promptMode,
    setPromptMode,
    promptText,
    setPromptText,
    transcriptCursor,
    setTranscriptCursor,
    transcriptEntries,
    expandedEntries: _expandedEntries,
    setExpandedEntries,
    transcriptScrollOffset: _transcriptScrollOffset,
    setTranscriptScrollOffset,
    transcriptViewHeight,
  } = nav;

  // -- Deny reason mode: capture text for denial message --
  if (denyReasonMode) {
    if (key.return) {
      const selectedSession = sessions[selectedIndex];
      const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
      if (perm) {
        const args: Record<string, string> = {
          sessionId: selectedSession.sessionId,
          requestId: perm.requestId,
        };
        if (denyReasonText) args.message = denyReasonText;
        ipcCall("callTool", {
          server: CLAUDE_SERVER_NAME,
          tool: "claude_deny",
          arguments: args,
        }).catch(() => {});
      }
      setDenyReasonText("");
      setDenyReasonMode(false);
      return true;
    }
    if (key.escape) {
      setDenyReasonText("");
      setDenyReasonMode(false);
      return true;
    }
    if (key.backspace || key.delete) {
      setDenyReasonText((prev) => prev.slice(0, -1));
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setDenyReasonText((prev) => prev + input);
    }
    return true;
  }

  // -- Prompt input mode: capture text for follow-up prompt --
  if (promptMode) {
    if (key.return) {
      const session = sessions[selectedIndex];
      if (session && promptText) {
        ipcCall("callTool", {
          server: CLAUDE_SERVER_NAME,
          tool: "claude_prompt",
          arguments: { sessionId: session.sessionId, prompt: promptText },
        }).catch(() => {});
      }
      setPromptText("");
      setPromptMode(false);
      return true;
    }
    if (key.escape) {
      setPromptText("");
      setPromptMode(false);
      return true;
    }
    if (key.backspace || key.delete) {
      setPromptText((prev) => prev.slice(0, -1));
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setPromptText((prev) => prev + input);
    }
    return true;
  }

  const selectedSession = sessions[selectedIndex];

  // When transcript is expanded, j/k navigate within transcript entries
  if (expandedSession) {
    if (key.upArrow || input === "k") {
      setTranscriptCursor((cur) => {
        const idx = cur ? transcriptEntries.findIndex((e) => entryKey(e) === cur) : 0;
        const next = Math.max(0, (idx === -1 ? 0 : idx) - 1);
        return transcriptEntries[next] ? entryKey(transcriptEntries[next]) : cur;
      });
      // Keep cursor visible in viewport
      setTranscriptScrollOffset((offset) => {
        const idx = transcriptCursor ? transcriptEntries.findIndex((e) => entryKey(e) === transcriptCursor) : 0;
        const next = Math.max(0, (idx === -1 ? 0 : idx) - 1);
        if (next < offset) return next;
        return offset;
      });
      return true;
    }
    if (key.downArrow || input === "j") {
      setTranscriptCursor((cur) => {
        const idx = cur ? transcriptEntries.findIndex((e) => entryKey(e) === cur) : -1;
        const next = Math.min(transcriptEntries.length - 1, (idx === -1 ? -1 : idx) + 1);
        return transcriptEntries[next] ? entryKey(transcriptEntries[next]) : cur;
      });
      // Keep cursor visible in viewport
      setTranscriptScrollOffset((offset) => {
        const idx = transcriptCursor ? transcriptEntries.findIndex((e) => entryKey(e) === transcriptCursor) : -1;
        const next = Math.min(transcriptEntries.length - 1, (idx === -1 ? -1 : idx) + 1);
        if (next >= offset + transcriptViewHeight) return next - transcriptViewHeight + 1;
        return offset;
      });
      return true;
    }

    // Enter: toggle expand/collapse selected entry
    if (key.return) {
      const cursorKey = transcriptCursor;
      if (cursorKey) {
        setExpandedEntries((prev) => {
          const next = new Set(prev);
          if (next.has(cursorKey)) {
            next.delete(cursorKey);
          } else {
            next.add(cursorKey);
          }
          return next;
        });
      }
      return true;
    }
  } else {
    // Navigate sessions (only when transcript not expanded)
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return true;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(Math.max(0, sessions.length - 1), i + 1));
      return true;
    }

    // Toggle transcript detail
    if (key.return) {
      if (selectedSession) {
        setExpandedSession(selectedSession.sessionId);
      }
      return true;
    }
  }

  // Navigate pending permissions within selected session
  if (key.leftArrow) {
    setPermissionIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.rightArrow) {
    const permCount = selectedSession?.pendingPermissionDetails?.length ?? 0;
    setPermissionIndex((i) => Math.min(Math.max(0, permCount - 1), i + 1));
    return true;
  }

  // Approve targeted pending permission
  if (input === "a") {
    const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
    if (perm) {
      ipcCall("callTool", {
        server: CLAUDE_SERVER_NAME,
        tool: "claude_approve",
        arguments: { sessionId: selectedSession.sessionId, requestId: perm.requestId },
      }).catch(() => {});
    }
    return true;
  }

  // Deny targeted pending permission — enter reason prompt
  if (input === "d") {
    const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
    if (perm) {
      setDenyReasonMode(true);
    }
    return true;
  }

  // Send follow-up prompt to selected session
  if (input === "p") {
    if (selectedSession) {
      setPromptMode(true);
    }
    return true;
  }

  // End session
  if (input === "x") {
    if (selectedSession) {
      ipcCall("callTool", {
        server: CLAUDE_SERVER_NAME,
        tool: "claude_bye",
        arguments: { sessionId: selectedSession.sessionId },
      }).catch(() => {});
      setExpandedSession(null);
    }
    return true;
  }

  return false;
}
