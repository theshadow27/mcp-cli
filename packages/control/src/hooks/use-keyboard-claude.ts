import { ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";
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
          server: "_claude",
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

  const selectedSession = sessions[selectedIndex];

  // Navigate sessions
  if (key.upArrow || input === "k") {
    setSelectedIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    setSelectedIndex((i) => Math.min(Math.max(0, sessions.length - 1), i + 1));
    return true;
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

  // Toggle transcript detail
  if (key.return) {
    if (selectedSession) {
      setExpandedSession(expandedSession === selectedSession.sessionId ? null : selectedSession.sessionId);
    }
    return true;
  }

  // Approve targeted pending permission
  if (input === "a") {
    const perm = selectedSession?.pendingPermissionDetails?.[permissionIndex];
    if (perm) {
      ipcCall("callTool", {
        server: "_claude",
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

  // End session
  if (input === "x") {
    if (selectedSession) {
      ipcCall("callTool", {
        server: "_claude",
        tool: "claude_bye",
        arguments: { sessionId: selectedSession.sessionId },
      }).catch(() => {});
      setExpandedSession(null);
    }
    return true;
  }

  return false;
}
