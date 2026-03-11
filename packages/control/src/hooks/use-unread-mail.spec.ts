import { afterEach, describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseUnreadMailOptions, useUnreadMail } from "./use-unread-mail";

interface HookState {
  unreadCount: number;
}

const Harness: FC<{ opts: UseUnreadMailOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
  const result = useUnreadMail(opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 10) {
  await Bun.sleep(ms);
}

describe("useUnreadMail", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseUnreadMailOptions) {
    const stateRef: { current: HookState } = {
      current: { unreadCount: 0 },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("polls readMail and sets unread count", async () => {
    const ipcCallFn = async () => ({
      messages: [
        { id: 1, sender: "a", recipient: "b", subject: null, body: null, replyTo: null, read: false, createdAt: "" },
        { id: 2, sender: "c", recipient: "b", subject: null, body: null, replyTo: null, read: false, createdAt: "" },
      ],
    });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseUnreadMailOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.unreadCount).toBe(2);
  });

  it("starts at zero and stays zero on error", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseUnreadMailOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.unreadCount).toBe(0);
  });

  it("stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { messages: [] };
    };

    const { instance } = mount({
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UseUnreadMailOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
