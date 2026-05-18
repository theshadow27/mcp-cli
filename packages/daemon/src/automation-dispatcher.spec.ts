import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AutomationAction, AutomationConfig, LockedAutomation, MonitorEvent } from "@mcp-cli/core";
import { AutomationDispatcher } from "./automation-dispatcher";
import { EventBus } from "./event-bus";

const POLL_INTERVAL_MS = 2;
const POLL_DEADLINE_MS = 2_000;

async function pollUntil(predicate: () => boolean, deadline = POLL_DEADLINE_MS): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > deadline) {
      throw new Error(`pollUntil timed out after ${deadline}ms`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    src: "test",
    event: "pr.merged",
    category: "work_item",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    preset: "supervised",
    modules: {},
    ...overrides,
  };
}

function makeLocked(overrides: Partial<LockedAutomation> = {}): LockedAutomation {
  return {
    name: "cleanup",
    resolvedPath: ".claude/automation/cleanup.ts",
    contentHash: "a".repeat(64),
    events: ["pr.merged"],
    enabled: true,
    ...overrides,
  };
}

describe("AutomationDispatcher", () => {
  let bus: EventBus;
  let dispatcher: AutomationDispatcher;
  let executedModules: Array<{ name: string; event: string }>;
  let executeResult: AutomationAction;

  beforeEach(() => {
    bus = new EventBus();
    executedModules = [];
    executeResult = { action: "none", reason: "test" };

    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });
  });

  afterEach(() => {
    dispatcher.stop();
  });

  test("subscribes to event bus and dispatches on matching event", async () => {
    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => executedModules.length >= 1);

    expect(executedModules).toHaveLength(1);
    expect(executedModules[0].name).toBe("cleanup");
    expect(executedModules[0].event).toBe("pr.merged");
  });

  test("does not dispatch on non-matching event", async () => {
    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent({ event: "pr.opened" }));
    // Publish a matching event after to confirm the first was skipped
    bus.publish(makeEvent());
    await pollUntil(() => executedModules.length >= 1);

    expect(executedModules).toHaveLength(1);
    expect(executedModules[0].event).toBe("pr.merged");
  });

  test("skips disabled module", async () => {
    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    dispatcher.load(makeConfig(), [makeLocked({ enabled: false })]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.length >= 1);

    expect(executedModules).toHaveLength(0);
  });

  test("emits automation.fired audit event", async () => {
    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) {
        published.push(event);
      }
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.fired"));

    const fired = published.find((e) => e.event === "automation.fired");
    expect(fired).toBeDefined();
    expect(fired?.module).toBe("cleanup");
    expect(fired?.category).toBe("automation");
    expect(fired?.src).toBe("automation:cleanup");
  });

  test("emits automation.skipped when disabled by override", async () => {
    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) {
        published.push(event);
      }
    });

    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      getWorkItemOverrides: () => "cleanup=false",
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent({ workItemId: "wi-1" }));
    await pollUntil(() => published.some((e) => e.event === "automation.skipped"));

    expect(executedModules).toHaveLength(0);
    const skipped = published.find((e) => e.event === "automation.skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.module).toBe("cleanup");
  });

  test("emits automation.escalated when handler returns escalate", async () => {
    executeResult = { action: "escalate", reason: "needs human review" };

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) {
        published.push(event);
      }
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.escalated"));

    const escalated = published.find((e) => e.event === "automation.escalated");
    expect(escalated).toBeDefined();
    expect(escalated?.reason).toBe("needs human review");
  });

  test("emits automation.errored when handler throws", async () => {
    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      executeModule: async () => {
        throw new Error("handler crashed");
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) {
        published.push(event);
      }
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.errored"));

    const errored = published.find((e) => e.event === "automation.errored");
    expect(errored).toBeDefined();
    expect(errored?.error).toBe("handler crashed");
  });

  test("per-item override can enable a disabled module", async () => {
    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      getWorkItemOverrides: () => "cleanup=true",
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return { action: "none", reason: "test" };
      },
    });

    dispatcher.load(makeConfig(), [makeLocked({ enabled: false })]);
    dispatcher.start();

    bus.publish(makeEvent({ workItemId: "wi-1" }));
    await pollUntil(() => executedModules.length >= 1);

    expect(executedModules).toHaveLength(1);
  });

  test("listModules returns registered modules", () => {
    dispatcher.load(makeConfig({ preset: "semi-auto" }), [
      makeLocked(),
      makeLocked({ name: "bind", events: ["pr.opened"], resolvedPath: "./bind.ts" }),
    ]);

    const modules = dispatcher.listModules();
    expect(modules).toHaveLength(2);
    expect(modules[0].name).toBe("bind");
    expect(modules[1].name).toBe("cleanup");
  });

  test("getAuditLog returns entries after fires", async () => {
    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => dispatcher.getAuditLog().length >= 1);

    const log = dispatcher.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].module).toBe("cleanup");
    expect(log[0].outcome).toBe("fired");
    expect(log[0].event).toBe("pr.merged");
    expect(log[0].actionType).toBe("none");
  });

  test("getAuditLog filters by module name", async () => {
    dispatcher.load(makeConfig(), [
      makeLocked(),
      makeLocked({ name: "bind", events: ["pr.merged"], resolvedPath: "./bind.ts" }),
    ]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => dispatcher.getAuditLog().length >= 2);

    const cleanupLog = dispatcher.getAuditLog("cleanup");
    expect(cleanupLog).toHaveLength(1);
    expect(cleanupLog[0].module).toBe("cleanup");

    const bindLog = dispatcher.getAuditLog("bind");
    expect(bindLog).toHaveLength(1);
    expect(bindLog[0].module).toBe("bind");
  });

  test("stop unsubscribes from event bus", async () => {
    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();
    dispatcher.stop();

    bus.publish(makeEvent());
    // Give enough time — no audit events should appear
    await Bun.sleep(20);

    expect(executedModules).toHaveLength(0);
    expect(published.filter((e) => e.event === "automation.fired")).toHaveLength(0);
  });

  test("moduleCount reflects loaded modules", () => {
    expect(dispatcher.moduleCount).toBe(0);
    dispatcher.load(makeConfig(), [makeLocked()]);
    expect(dispatcher.moduleCount).toBe(1);
  });

  test("ring buffer returns newest entries in chronological order after wrapping", async () => {
    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    const totalEvents = 220;
    for (let i = 0; i < totalEvents; i++) {
      bus.publish(makeEvent({ seq: i }));
    }
    await pollUntil(() => dispatcher.getAuditLog(undefined, 300).length >= 200);

    const log = dispatcher.getAuditLog(undefined, 50);
    expect(log).toHaveLength(50);
    // Newest 50 entries should be the last 50 events published (seq 170-219).
    // They should be in chronological order (oldest first within the slice).
    for (let i = 1; i < log.length; i++) {
      expect(log[i].ts >= log[i - 1].ts).toBe(true);
    }

    const fullLog = dispatcher.getAuditLog(undefined, 300);
    expect(fullLog).toHaveLength(200);
  });

  test("preset defaults apply when module enabled is undefined in lockfile", async () => {
    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    // Module with enabled=false should be skipped under any preset
    // (lockfile resolves enabled at install time; this tests the dispatcher
    // respects the resolved value)
    dispatcher.load(makeConfig({ preset: "supervised" }), [makeLocked({ enabled: false })]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.skipped"));

    expect(executedModules).toHaveLength(0);
    expect(published.some((e) => e.event === "automation.skipped")).toBe(true);
  });

  test("skipped audit entries use skipReason instead of error", async () => {
    dispatcher.load(makeConfig(), [makeLocked({ enabled: false })]);
    dispatcher.start();

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.skipped"));

    const log = dispatcher.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe("skipped");
    expect(log[0].skipReason).toBe("disabled by config or override");
    expect(log[0].error).toBeNull();
  });

  test("resolves workItemId from prNumber via resolveWorkItemId", async () => {
    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      getWorkItemOverrides: (workItemId) => {
        if (workItemId === "#42") return "cleanup=false";
        return undefined;
      },
      resolveWorkItemId: (prNumber) => {
        if (prNumber === 42) return "#42";
        return undefined;
      },
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent({ prNumber: 42 }));
    await pollUntil(() => published.some((e) => e.event === "automation.skipped"));

    expect(executedModules).toHaveLength(0);
    const skipped = published.find((e) => e.event === "automation.skipped");
    expect(skipped).toBeDefined();
  });

  test("default executor loads and calls module from resolvedPath", async () => {
    const fixtureDir = import.meta.dir;
    const defaultDispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: fixtureDir,
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    defaultDispatcher.load(makeConfig(), [
      makeLocked({
        resolvedPath: "test-fixtures/echo-automation.ts",
        events: ["pr.merged"],
      }),
    ]);
    defaultDispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.fired"));

    const fired = published.find((e) => e.event === "automation.fired");
    expect(fired).toBeDefined();
    expect(fired?.actionType).toBe("none");

    const log = defaultDispatcher.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe("fired");

    defaultDispatcher.stop();
  });

  test("default executor emits errored when module has no fn export", async () => {
    const fixtureDir = import.meta.dir;
    const defaultDispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: fixtureDir,
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    defaultDispatcher.load(makeConfig(), [
      makeLocked({
        resolvedPath: "test-fixtures/bad-automation.ts",
        events: ["pr.merged"],
      }),
    ]);
    defaultDispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.errored"));

    const errored = published.find((e) => e.event === "automation.errored");
    expect(errored).toBeDefined();
    expect(errored?.error).toContain("no default export with an fn()");

    defaultDispatcher.stop();
  });

  test("default executor emits errored when module file is missing", async () => {
    const defaultDispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/nonexistent/path",
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    defaultDispatcher.load(makeConfig(), [
      makeLocked({
        resolvedPath: "does-not-exist.ts",
        events: ["pr.merged"],
      }),
    ]);
    defaultDispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.errored"));

    const errored = published.find((e) => e.event === "automation.errored");
    expect(errored).toBeDefined();
    expect(errored?.error).toContain("failed to load");

    defaultDispatcher.stop();
  });

  // ── Action execution (#2020) ──

  test("bye-and-untrack action calls actionExecutor.byeAndUntrack", async () => {
    const byeCalls: Array<{ workItemId: string; sessionIds: string[] }> = [];
    executeResult = { action: "bye-and-untrack", sessionIds: ["sess-1", "sess-2"] };

    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      resolveWorkItemId: () => "#42",
      actionExecutor: {
        async byeAndUntrack(workItemId, sessionIds) {
          byeCalls.push({ workItemId, sessionIds });
        },
      },
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent({ prNumber: 42 }));
    await pollUntil(() => byeCalls.length >= 1);

    expect(byeCalls).toHaveLength(1);
    expect(byeCalls[0].workItemId).toBe("#42");
    expect(byeCalls[0].sessionIds).toEqual(["sess-1", "sess-2"]);
  });

  test("bye-and-untrack is no-op without workItemId", async () => {
    const byeCalls: Array<{ workItemId: string; sessionIds: string[] }> = [];
    executeResult = { action: "bye-and-untrack", sessionIds: ["sess-1"] };

    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      actionExecutor: {
        async byeAndUntrack(workItemId, sessionIds) {
          byeCalls.push({ workItemId, sessionIds });
        },
      },
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.fired"));

    expect(byeCalls).toHaveLength(0);
  });

  test("fired audit event includes sessionIds for bye-and-untrack", async () => {
    executeResult = { action: "bye-and-untrack", sessionIds: ["sess-a", "sess-b"] };

    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      resolveWorkItemId: () => "#99",
      actionExecutor: { async byeAndUntrack() {} },
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent({ prNumber: 99 }));
    await pollUntil(() => published.some((e) => e.event === "automation.fired"));

    const fired = published.find((e) => e.event === "automation.fired");
    expect(fired?.sessionIds).toEqual(["sess-a", "sess-b"]);
    expect(fired?.actionType).toBe("bye-and-untrack");
  });

  test("none action does not call actionExecutor", async () => {
    const byeCalls: string[] = [];
    executeResult = { action: "none", reason: "nothing to do" };

    dispatcher = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: "/test/repo",
      actionExecutor: {
        async byeAndUntrack() {
          byeCalls.push("called");
        },
      },
      executeModule: async (mod, event) => {
        executedModules.push({ name: mod.name, event: event.event });
        return executeResult;
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((event) => {
      if (event.event.startsWith("automation.")) published.push(event);
    });

    dispatcher.load(makeConfig(), [makeLocked()]);
    dispatcher.start();

    bus.publish(makeEvent());
    await pollUntil(() => published.some((e) => e.event === "automation.fired"));

    expect(byeCalls).toHaveLength(0);
  });

  // ── ctx.workItem and ctx.state in default executor (#2020) ──

  test("default executor populates ctx.workItem from getWorkItem callback", async () => {
    const fixtureDir = import.meta.dir;

    const d = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: fixtureDir,
      resolveWorkItemId: () => "#55",
      getWorkItem: (id) => {
        if (id === "#55") return { id: "#55", issueNumber: 55, prNumber: 100, branch: "feat/x", phase: "qa" };
        return null;
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((e) => published.push(e));

    d.load(makeConfig(), [
      makeLocked({
        resolvedPath: "test-fixtures/workitem-echo-automation.ts",
        events: ["pr.merged"],
      }),
    ]);
    d.start();

    bus.publish(makeEvent({ prNumber: 100 }));
    await pollUntil(() => published.some((e) => e.event === "test.workitem"));

    const emitted = published.find((e) => e.event === "test.workitem");
    expect(emitted).toBeDefined();
    expect(emitted?.workItemId).toBe("#55");
    expect(emitted?.phase).toBe("qa");
    expect(emitted?.prNumber).toBe(100);
    d.stop();
  });

  test("default executor provides read-only ctx.state from getWorkItemState", async () => {
    const fixtureDir = import.meta.dir;

    const d = new AutomationDispatcher({
      eventBus: bus,
      repoRoot: fixtureDir,
      resolveWorkItemId: () => "#77",
      getWorkItemState: (id) => {
        if (id === "#77") return { session_id: "sess-1", qa_session_id: "sess-2" };
        return {};
      },
    });

    const published: MonitorEvent[] = [];
    bus.subscribe((e) => {
      if (e.event.startsWith("automation.")) published.push(e);
    });

    d.load(makeConfig(), [makeLocked({ resolvedPath: "test-fixtures/echo-automation.ts", events: ["pr.merged"] })]);
    d.start();

    bus.publish(makeEvent({ prNumber: 77 }));
    await pollUntil(() => published.some((e) => e.event === "automation.fired"));

    const fired = published.find((e) => e.event === "automation.fired");
    expect(fired).toBeDefined();
    d.stop();
  });
});
