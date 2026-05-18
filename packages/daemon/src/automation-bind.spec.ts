import { beforeEach, describe, expect, test } from "bun:test";
import type { AutomationAction, AutomationContext, MonitorEvent, WorkItem } from "@mcp-cli/core";
import { createWorkItem } from "@mcp-cli/core";

import bindModule from "../../../.claude/automation/bind";

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    src: "daemon.work-item-poller",
    event: "pr.opened",
    category: "work_item",
    prNumber: 42,
    branch: "feat/issue-100-foo",
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem("#100"),
    issueNumber: 100,
    branch: "feat/issue-100-foo",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<AutomationContext> = {}): AutomationContext {
  return {
    mcp: new Proxy({} as AutomationContext["mcp"], {
      get: (_, prop) => {
        throw new Error(`mcp.${String(prop)} not available`);
      },
    }),
    state: new Proxy({} as AutomationContext["state"], {
      get: (_, prop) => {
        throw new Error(`state.${String(prop)} not available`);
      },
    }),
    repoRoot: "/test/repo",
    signal: AbortSignal.timeout(5_000),
    workItem: null,
    config: {},
    findWorkItemByBranch: () => null,
    findWorkItemByIssue: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    emit: () => {},
    ...overrides,
  };
}

describe("bind automation module", () => {
  test("binds PR to tracked item matched by branch", async () => {
    const item = makeWorkItem({ prNumber: null });
    const ctx = makeCtx({
      findWorkItemByBranch: (branch) => (branch === "feat/issue-100-foo" ? item : null),
    });

    const result = await bindModule.fn(makeEvent(), ctx);

    expect(result.action).toBe("set-state");
    expect((result as { patch: Record<string, unknown> }).patch).toEqual({
      prNumber: 42,
      branch: "feat/issue-100-foo",
    });
  });

  test("no-op when item already has prNumber", async () => {
    const item = makeWorkItem({ prNumber: 99 });
    const ctx = makeCtx({
      findWorkItemByBranch: () => item,
    });

    const result = await bindModule.fn(makeEvent(), ctx);

    expect(result.action).toBe("none");
    expect((result as { reason: string }).reason).toContain("already bound to PR #99");
  });

  test("no-op when no tracked item matches branch", async () => {
    const ctx = makeCtx({
      findWorkItemByBranch: () => null,
      findWorkItemByIssue: () => null,
    });

    const result = await bindModule.fn(makeEvent(), ctx);

    expect(result.action).toBe("none");
    expect((result as { reason: string }).reason).toContain("no tracked item");
  });

  test("no-op when event missing prNumber", async () => {
    const event = makeEvent({ prNumber: undefined });
    const ctx = makeCtx();

    const result = await bindModule.fn(event, ctx);

    expect(result.action).toBe("none");
    expect((result as { reason: string }).reason).toBe("event missing prNumber or branch");
  });

  test("no-op when event missing branch", async () => {
    const event = makeEvent();
    (event as Record<string, unknown>).branch = undefined;
    const ctx = makeCtx();

    const result = await bindModule.fn(event, ctx);

    expect(result.action).toBe("none");
    expect((result as { reason: string }).reason).toBe("event missing prNumber or branch");
  });

  test("branchPattern extracts issue number and matches by issue", async () => {
    const item = makeWorkItem({ prNumber: null, branch: null });
    const ctx = makeCtx({
      config: { branchPattern: "^(?:feat|fix)/issue-(?<issue>\\d+)-" },
      findWorkItemByBranch: () => null,
      findWorkItemByIssue: (n) => (n === 100 ? item : null),
    });

    const result = await bindModule.fn(makeEvent({ branch: "feat/issue-100-widget" }), ctx);

    expect(result.action).toBe("set-state");
    expect((result as { patch: Record<string, unknown> }).patch).toEqual({
      prNumber: 42,
      branch: "feat/issue-100-widget",
    });
  });

  test("branchPattern no-op when pattern does not match branch", async () => {
    const ctx = makeCtx({
      config: { branchPattern: "^(?:feat|fix)/issue-(?<issue>\\d+)-" },
      findWorkItemByBranch: () => null,
      findWorkItemByIssue: () => null,
    });

    const result = await bindModule.fn(makeEvent({ branch: "chore/cleanup" }), ctx);

    expect(result.action).toBe("none");
    expect((result as { reason: string }).reason).toContain("no tracked item");
  });

  test("direct branch match takes priority over branchPattern", async () => {
    const branchItem = makeWorkItem({ id: "#200", prNumber: null, branch: "feat/issue-100-foo" });
    const issueItem = makeWorkItem({ id: "#100", prNumber: null });
    const ctx = makeCtx({
      config: { branchPattern: "^feat/issue-(?<issue>\\d+)-" },
      findWorkItemByBranch: (b) => (b === "feat/issue-100-foo" ? branchItem : null),
      findWorkItemByIssue: (n) => (n === 100 ? issueItem : null),
    });

    const result = (await bindModule.fn(makeEvent(), ctx)) as { action: string; patch: Record<string, unknown> };

    expect(result.action).toBe("set-state");
    expect(result.patch.prNumber).toBe(42);
  });

  describe("integration with dispatcher", () => {
    let bus: import("./event-bus").EventBus;

    beforeEach(async () => {
      const { EventBus } = await import("./event-bus");
      bus = new EventBus();
    });

    test("dispatcher fires bind module and records audit", async () => {
      const { AutomationDispatcher } = await import("./automation-dispatcher");
      const item = makeWorkItem({ prNumber: null });

      const dispatcher = new AutomationDispatcher({
        eventBus: bus,
        repoRoot: import.meta.dir,
        getWorkItemByBranch: (branch) => (branch === "feat/issue-100-foo" ? item : null),
        getWorkItemByIssue: () => null,
        executeModule: async (_mod, event) => {
          const ctx = makeCtx({
            findWorkItemByBranch: (b) => (b === "feat/issue-100-foo" ? item : null),
          });
          return bindModule.fn(event, ctx);
        },
      });

      const published: MonitorEvent[] = [];
      bus.subscribe((event) => {
        if (event.event.startsWith("automation.")) published.push(event);
      });

      dispatcher.load({ preset: "semi-auto", modules: {} }, [
        {
          name: "bind",
          resolvedPath: ".claude/automation/bind.ts",
          contentHash: "a".repeat(64),
          events: ["pr.opened"],
          enabled: true,
        },
      ]);
      dispatcher.start();

      bus.publish(makeEvent());

      const start = performance.now();
      while (!published.some((e) => e.event === "automation.fired") && performance.now() - start < 2_000) {
        await Bun.sleep(2);
      }

      const fired = published.find((e) => e.event === "automation.fired");
      expect(fired).toBeDefined();
      expect(fired?.module).toBe("bind");
      expect(fired?.actionType).toBe("set-state");

      dispatcher.stop();
    });

    test("per-item override blocks bind module", async () => {
      const { AutomationDispatcher } = await import("./automation-dispatcher");
      const executedModules: string[] = [];

      const dispatcher = new AutomationDispatcher({
        eventBus: bus,
        repoRoot: import.meta.dir,
        getWorkItemOverrides: () => "bind=false",
        resolveWorkItemId: () => "#100",
        executeModule: async (mod) => {
          executedModules.push(mod.name);
          return { action: "none", reason: "test" };
        },
      });

      const published: MonitorEvent[] = [];
      bus.subscribe((event) => {
        if (event.event.startsWith("automation.")) published.push(event);
      });

      dispatcher.load({ preset: "semi-auto", modules: {} }, [
        {
          name: "bind",
          resolvedPath: ".claude/automation/bind.ts",
          contentHash: "a".repeat(64),
          events: ["pr.opened"],
          enabled: true,
        },
      ]);
      dispatcher.start();

      bus.publish(makeEvent({ workItemId: "#100" }));

      const start = performance.now();
      while (!published.some((e) => e.event === "automation.skipped") && performance.now() - start < 2_000) {
        await Bun.sleep(2);
      }

      expect(executedModules).toHaveLength(0);
      const skipped = published.find((e) => e.event === "automation.skipped");
      expect(skipped).toBeDefined();
      expect(skipped?.module).toBe("bind");

      dispatcher.stop();
    });
  });
});
