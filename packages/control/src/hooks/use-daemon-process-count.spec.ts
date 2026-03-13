import { afterEach, describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import {
  type UseDaemonProcessCountOptions,
  countDaemonProcesses,
  useDaemonProcessCount,
} from "./use-daemon-process-count";

const Harness: FC<{ opts: UseDaemonProcessCountOptions; stateRef: { current: number } }> = ({ opts, stateRef }) => {
  const count = useDaemonProcessCount(opts);
  stateRef.current = count;
  return React.createElement(Text, null, `count:${count}`);
};

async function flush(ms = 20) {
  await Bun.sleep(ms);
}

describe("countDaemonProcesses", () => {
  it("returns a non-negative number", async () => {
    const count = await countDaemonProcesses();
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });
});

describe("useDaemonProcessCount", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseDaemonProcessCountOptions) {
    const stateRef = { current: 0 };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("returns count from countFn", async () => {
    const countFn = async () => 3;
    const { stateRef } = mount({ countFn });

    await flush();
    expect(stateRef.current).toBe(3);
  });

  it("defaults to 0 before first poll", () => {
    const countFn = async () => {
      await Bun.sleep(100);
      return 2;
    };
    const { stateRef } = mount({ countFn });
    expect(stateRef.current).toBe(0);
  });

  it("updates on subsequent polls", async () => {
    let callCount = 0;
    const countFn = async () => {
      callCount++;
      return callCount;
    };

    const { stateRef } = mount({ countFn, intervalMs: 30 });

    await flush();
    expect(stateRef.current).toBe(1);

    await flush(50);
    expect(stateRef.current).toBeGreaterThan(1);
  });

  it("stops polling on unmount", async () => {
    let callCount = 0;
    const countFn = async () => {
      callCount++;
      return 1;
    };

    const { instance } = mount({ countFn, intervalMs: 30 });
    await flush(50);

    instance.unmount();
    instances.pop();
    // Allow any in-flight poll to complete
    await flush(20);
    const countAfterUnmount = callCount;

    // No new polls should fire after unmount settles
    await flush(100);
    expect(callCount).toBe(countAfterUnmount);
  });
});
