import { afterEach, describe, expect, it } from "bun:test";
import type { MailMessage } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseMailOptions, useMail } from "./use-mail";

interface HookState {
  messages: MailMessage[];
}

const Harness: FC<{ opts: UseMailOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
  const result = useMail(opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 10) {
  await Bun.sleep(ms);
}

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

describe("useMail", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseMailOptions) {
    const stateRef: { current: HookState } = {
      current: { messages: [] },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches messages via readMail with recipient filter", async () => {
    const msgs = [makeMsg({ id: 1 }), makeMsg({ id: 2, read: true })];
    let calledParams: Record<string, unknown> = {};
    const ipcCallFn = async (_method: string, params: Record<string, unknown>) => {
      calledParams = params;
      return { messages: msgs };
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseMailOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.messages).toHaveLength(2);
    expect(stateRef.current.messages[0].id).toBe(1);
    expect(calledParams.recipient).toBe("human");
  });

  it("returns empty array on error", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseMailOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.messages).toHaveLength(0);
  });

  it("does not poll when disabled", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { messages: [] };
    };

    mount({
      enabled: false,
      ipcCallFn: ipcCallFn as UseMailOptions["ipcCallFn"],
    });

    await flush(50);
    expect(callCount).toBe(0);
  });

  it("stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { messages: [] };
    };

    const { instance } = mount({
      ipcCallFn: ipcCallFn as UseMailOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
