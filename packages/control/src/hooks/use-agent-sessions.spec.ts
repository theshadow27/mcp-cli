import { afterEach, describe, expect, it } from "bun:test";
import type { AgentSessionInfo } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseAgentSessionsOptions, useAgentSessions } from "./use-agent-sessions";

/* ---------- helpers ---------- */

/** Minimal AgentSessionInfo fixture */
function session(id: string, provider: "claude" | "codex" = "claude"): AgentSessionInfo {
  return {
    sessionId: id,
    provider,
    state: "active",
    model: "opus",
    cwd: "/tmp",
    cost: provider === "claude" ? 0 : null,
    tokens: 0,
    reasoningTokens: 0,
    numTurns: 0,
    pendingPermissions: 0,
    pendingPermissionDetails: [],
    worktree: null,
    repoRoot: null,
    processAlive: true,
    rateLimited: false,
    createdAt: Date.now(),
  };
}

/** Mutable ref to capture hook state without parsing rendered output */
interface HookState {
  sessions: AgentSessionInfo[];
  loading: boolean;
  error: string | null;
}

/** Wrapper component that captures hook state into a shared ref */
const Harness: FC<{ opts: UseAgentSessionsOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
  const result = useAgentSessions(opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

/** Flush microtask queue and give React time to re-render */
async function flush(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- tests ---------- */

describe("useAgentSessions", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseAgentSessionsOptions) {
    const stateRef: { current: HookState } = {
      current: { sessions: [], loading: true, error: null },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("merges sessions from both providers", async () => {
    const claudeSessions = [session("c1", "claude")];
    const codexSessions = [session("x1", "codex")];
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      const tool = (params as { tool: string }).tool;
      if (tool === "claude_session_list") {
        return { content: [{ type: "text", text: JSON.stringify(claudeSessions) }] };
      }
      if (tool === "codex_session_list") {
        return { content: [{ type: "text", text: JSON.stringify(codexSessions) }] };
      }
      return { content: [] };
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseAgentSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.sessions).toHaveLength(2);
    expect(stateRef.current.sessions[0].sessionId).toBe("c1");
    expect(stateRef.current.sessions[1].sessionId).toBe("x1");
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
  });

  it("continues when one provider fails", async () => {
    const claudeSessions = [session("c1", "claude")];
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      const tool = (params as { tool: string }).tool;
      if (tool === "claude_session_list") {
        return { content: [{ type: "text", text: JSON.stringify(claudeSessions) }] };
      }
      throw new Error("codex server offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseAgentSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.sessions).toHaveLength(1);
    expect(stateRef.current.sessions[0].provider).toBe("claude");
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
  });

  it("skips polling when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { stateRef } = mount({
      enabled: false,
      ipcCallFn: ipcCallFn as UseAgentSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(callCount).toBe(0);
    expect(stateRef.current.loading).toBe(true);
    expect(stateRef.current.sessions).toEqual([]);
  });

  it("sets empty sessions when both providers return empty", async () => {
    const ipcCallFn = async () => ({ content: [{ type: "text", text: "[]" }] });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseAgentSessionsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.sessions).toEqual([]);
    expect(stateRef.current.loading).toBe(false);
  });

  it("polls repeatedly at the given interval", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    mount({
      intervalMs: 50,
      ipcCallFn: ipcCallFn as UseAgentSessionsOptions["ipcCallFn"],
    });

    await flush(150);
    // Each poll calls 2 providers, so callCount should be at least 6
    expect(callCount).toBeGreaterThanOrEqual(6);
  });

  it("cleanup clears interval on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { instance } = mount({
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UseAgentSessionsOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
