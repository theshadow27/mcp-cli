import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@mcp-cli/core";
import type { MonitorEvent } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { EventBus } from "./event-bus";
import { MONITOR_RESTART_POLICY, type MonitorAlias, MonitorRuntime, getMonitorBackoff } from "./monitor-runtime";

function writeMonitorScript(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, source);
  return path;
}

async function pollUntil(condition: () => boolean, timeoutMs = 5_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(intervalMs);
  }
  if (!condition()) {
    throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
  }
}

// ── getMonitorBackoff ──

describe("getMonitorBackoff", () => {
  const delays = MONITOR_RESTART_POLICY.backoffDelaysMs;

  test("attempt 0 returns first delay", () => {
    expect(getMonitorBackoff(0, delays)).toBe(5_000);
  });

  test("attempt 1 returns second delay", () => {
    expect(getMonitorBackoff(1, delays)).toBe(15_000);
  });

  test("attempt beyond schedule clamps to last value", () => {
    expect(getMonitorBackoff(10, delays)).toBe(300_000);
  });

  test("negative attempt returns first delay", () => {
    expect(getMonitorBackoff(-1, delays)).toBe(5_000);
  });
});

// ── MONITOR_RESTART_POLICY ──

describe("MONITOR_RESTART_POLICY", () => {
  test("has issue-specified backoff schedule", () => {
    expect(MONITOR_RESTART_POLICY.backoffDelaysMs).toEqual([5_000, 15_000, 60_000, 180_000, 300_000]);
  });

  test("crash window is 10 minutes", () => {
    expect(MONITOR_RESTART_POLICY.crashWindowMs).toBe(600_000);
  });
});

// ── MonitorRuntime ──

describe("MonitorRuntime", () => {
  let runtime: MonitorRuntime | undefined;

  afterEach(async () => {
    await runtime?.stopAll();
    runtime = undefined;
  });

  test("generator that yields 3 events produces 3 bus publishes", async () => {
    using opts = testOptions();
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const scriptPath = writeMonitorScript(
      opts.ALIASES_DIR,
      "ticker",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "ticker",
  description: "Emits 3 ticks",
  subscribe: async function*(ctx) {
    for (let i = 0; i < 3; i++) {
      yield { event: "tick", category: "heartbeat", count: i };
    }
  },
});`,
    );

    const aliases: MonitorAlias[] = [
      {
        name: "ticker",
        filePath: scriptPath,
        aliasType: "defineMonitor",
      },
    ];

    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => aliases,
      getAlias: (n) => aliases.find((a) => a.name === n),
    });

    await runtime.startAll();
    await pollUntil(() => received.length >= 3);

    expect(received).toHaveLength(3);
    expect(received[0].src).toBe("alias:ticker");
    expect(received[0].event).toBe("tick");
    expect(received[0].category).toBe("heartbeat");
    expect((received[0] as Record<string, unknown>).count).toBe(0);
    expect((received[2] as Record<string, unknown>).count).toBe(2);
  });

  test("stopAll terminates running monitors", async () => {
    using opts = testOptions();
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const scriptPath = writeMonitorScript(
      opts.ALIASES_DIR,
      "slow",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "slow",
  subscribe: async function*(ctx) {
    let i = 0;
    while (!ctx.signal.aborted) {
      yield { event: "tick", category: "heartbeat", n: i++ };
      await Bun.sleep(100);
    }
  },
});`,
    );

    const aliases: MonitorAlias[] = [{ name: "slow", filePath: scriptPath, aliasType: "defineMonitor" }];

    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => aliases,
      getAlias: (n) => aliases.find((a) => a.name === n),
    });

    await runtime.startAll();
    await pollUntil(() => received.length >= 1);

    await runtime.stopAll();
    expect(runtime.runningCount).toBe(0);
  });

  test("crashed monitor publishes alias.crashed event", async () => {
    using opts = testOptions();
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const scriptPath = writeMonitorScript(
      opts.ALIASES_DIR,
      "crasher",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "crasher",
  subscribe: async function*(ctx) {
    throw new Error("boom");
  },
});`,
    );

    const aliases: MonitorAlias[] = [{ name: "crasher", filePath: scriptPath, aliasType: "defineMonitor" }];

    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => aliases,
      getAlias: (n) => aliases.find((a) => a.name === n),
    });

    await runtime.startAll();
    await pollUntil(() => received.some((e) => e.event === "alias.crashed"));

    const crashEvent = received.find((e) => e.event === "alias.crashed");
    expect(crashEvent).toBeDefined();
    expect(crashEvent?.src).toBe("daemon.alias-supervisor");
    expect((crashEvent as Record<string, unknown>).name).toBe("crasher");
    expect(typeof (crashEvent as Record<string, unknown>).errorMessage).toBe("string");
  });

  test("dispose cleans up subscription IDs", async () => {
    const bus = new EventBus();

    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => [],
      getAlias: () => undefined,
    });

    expect(runtime.activeSubscriptionIds).toHaveLength(0);
    runtime.dispose();
    expect(runtime.activeSubscriptionIds).toHaveLength(0);
  });

  test("restartMonitor replaces a running monitor", async () => {
    using opts = testOptions();
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const scriptPath = writeMonitorScript(
      opts.ALIASES_DIR,
      "restartable",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "restartable",
  subscribe: async function*(ctx) {
    yield { event: "started", category: "heartbeat" };
    while (!ctx.signal.aborted) {
      await Bun.sleep(100);
    }
  },
});`,
    );

    const aliases: MonitorAlias[] = [{ name: "restartable", filePath: scriptPath, aliasType: "defineMonitor" }];

    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => aliases,
      getAlias: (n) => aliases.find((a) => a.name === n),
    });

    await runtime.startAll();
    await pollUntil(() => received.some((e) => e.event === "started"));

    const countBefore = received.filter((e) => e.event === "started").length;
    await runtime.restartMonitor("restartable");
    await pollUntil(() => received.filter((e) => e.event === "started").length > countBefore);

    const startEvents = received.filter((e) => e.event === "started");
    expect(startEvents.length).toBeGreaterThanOrEqual(2);
    expect(runtime.runningCount).toBe(1);
  });

  test("startAll with no monitors is a no-op", async () => {
    const bus = new EventBus();
    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => [],
      getAlias: () => undefined,
    });

    await runtime.startAll();
    expect(runtime.runningCount).toBe(0);
  });

  test("restartMonitor for non-existent alias is a no-op", async () => {
    const bus = new EventBus();
    runtime = new MonitorRuntime({
      bus,
      logger: silentLogger,
      listMonitors: () => [],
      getAlias: () => undefined,
    });

    await runtime.restartMonitor("nonexistent");
    expect(runtime.runningCount).toBe(0);
  });
});
