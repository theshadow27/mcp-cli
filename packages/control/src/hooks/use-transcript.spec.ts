import { afterEach, describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import type { TranscriptEntry } from "../components/agent-session-detail.js";
import { type UseTranscriptOptions, useTranscript } from "./use-transcript.js";

interface HookState {
  entries: TranscriptEntry[];
  error: string | null;
}

const Harness: FC<{
  sessionId: string | null;
  provider?: string;
  opts: UseTranscriptOptions;
  stateRef: { current: HookState };
}> = ({ sessionId, provider = "claude", opts, stateRef }) => {
  const result = useTranscript(sessionId, provider, opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 20) {
  await Bun.sleep(ms);
}

describe("useTranscript", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(sessionId: string | null, opts: UseTranscriptOptions = {}, provider = "claude") {
    const stateRef: { current: HookState } = {
      current: { entries: [], error: null },
    };
    const instance = render(React.createElement(Harness, { sessionId, provider, opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("skips polling when sessionId is null", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    mount(null, { ipcCallFn: ipcCallFn as UseTranscriptOptions["ipcCallFn"] });

    await flush(50);
    expect(callCount).toBe(0);
  });

  it("clears entries when sessionId is null", async () => {
    const { stateRef } = mount(null, {
      ipcCallFn: async () => ({ content: [] }) as never,
    });

    await flush();
    expect(stateRef.current.entries).toEqual([]);
    expect(stateRef.current.error).toBeNull();
  });

  it("fetches transcript when sessionId is provided", async () => {
    const fakeEntries: TranscriptEntry[] = [
      { timestamp: 0, direction: "inbound", message: { role: "user", content: "hello" } },
    ];
    const ipcCallFn = async () => ({
      content: [{ type: "text", text: JSON.stringify(fakeEntries) }],
    });

    const { stateRef } = mount("session-abc", {
      ipcCallFn: ipcCallFn as UseTranscriptOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.entries).toEqual(fakeEntries);
    expect(stateRef.current.error).toBeNull();
  });

  it("sets error state when ipcCallFn throws", async () => {
    const ipcCallFn = async () => {
      throw new Error("connection refused");
    };

    const { stateRef } = mount("session-xyz", {
      ipcCallFn: ipcCallFn as UseTranscriptOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.error).toBe("connection refused");
  });

  it("stops polling when unmounted", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { instance } = mount("session-abc", {
      ipcCallFn: ipcCallFn as UseTranscriptOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });

  it("routes to codex server when provider is codex", async () => {
    let capturedServer: string | undefined;
    let capturedTool: string | undefined;
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      capturedServer = (params as { server: string }).server;
      capturedTool = (params as { tool: string }).tool;
      return { content: [{ type: "text", text: "[]" }] };
    };

    mount("session-codex", { ipcCallFn: ipcCallFn as UseTranscriptOptions["ipcCallFn"] }, "codex");

    await flush();
    expect(capturedServer).toBe("_codex");
    expect(capturedTool).toBe("codex_transcript");
  });
});
