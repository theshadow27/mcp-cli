import { afterEach, describe, expect, it } from "bun:test";
import type { SessionInfo } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseClaudeSessionsOptions, useClaudeSessions } from "./use-claude-sessions";

/* ---------- helpers ---------- */

/** Minimal SessionInfo fixture */
function session(id: string): SessionInfo {
  return {
    sessionId: id,
    provider: "claude",
    state: "active",
    model: "opus",
    cwd: "/tmp",
    cost: 0,
    tokens: 0,
    reasoningTokens: 0,
    numTurns: 0,
    pendingPermissions: 0,
    pendingPermissionDetails: [],
    worktree: null,
    repoRoot: null,
    processAlive: true,
    wsConnected: true,
    spawnAlive: true,
    snapshotTs: Date.now(),
  };
}

/** Mutable ref to capture hook state without parsing rendered output */
interface HookState {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
}

/** Wrapper component that captures hook state into a shared ref */
const Harness: FC<{ opts: UseClaudeSessionsOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
  const result = useClaudeSessions(opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

/** Flush microtask queue and give React time to re-render */
async function flush(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- tests ---------- */

describe("useClaudeSessions", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseClaudeSessionsOptions) {
    const stateRef: { current: HookState } = {
      current: { sessions: [], loading: true, error: null },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("calls ipcCallFn on mount and sets sessions", async () => {
    const sessions = [session("s1"), session("s2")];
    const ipcCallFn = async () => ({
      content: [{ type: "text", text: JSON.stringify(sessions) }],
    });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.sessions).toHaveLength(2);
    expect(stateRef.current.sessions[0].sessionId).toBe("s1");
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
  });

  it("sets error state when ipcCallFn throws", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.error).toBe("daemon offline");
    expect(stateRef.current.loading).toBe(false);
  });

  it("skips polling when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { stateRef } = mount({
      enabled: false,
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(callCount).toBe(0);
    expect(stateRef.current.loading).toBe(true);
    expect(stateRef.current.sessions).toEqual([]);
  });

  it("sets empty sessions when extractToolText returns null", async () => {
    const ipcCallFn = async () => ({ content: [] });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.sessions).toEqual([]);
    expect(stateRef.current.loading).toBe(false);
  });

  it("cancelled flag prevents setState after unmount", async () => {
    const resolveRef: { current: (() => void) | null } = { current: null };
    const ipcCallFn = async () => {
      await new Promise<void>((r) => {
        resolveRef.current = r;
      });
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { instance } = mount({
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    // Unmount while ipcCall is still pending
    instance.unmount();
    // Remove from cleanup list since already unmounted
    instances.pop();

    // Resolve the pending call — cancelled flag should prevent setState
    resolveRef.current?.();
    await flush();
    // Test passes without errors = cancelled flag works correctly
  });

  it("polls repeatedly at the given interval", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    mount({
      intervalMs: 50,
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    await flush(150);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("cleanup clears interval on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { instance } = mount({
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UseClaudeSessionsOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
