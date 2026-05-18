import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AutomationContext, MonitorEvent } from "@mcp-cli/core";

const CLEANUP_PATH = resolve(import.meta.dir, "../../../.claude/automation/cleanup.ts");

async function loadCleanup() {
  const mod = await import(CLEANUP_PATH);
  return mod.default as import("@mcp-cli/core").AutomationDefinition;
}

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    src: "test",
    event: "pr.merged",
    category: "work_item",
    prNumber: 42,
    mergeSha: "abc123def456",
    ...overrides,
  };
}

function makeCtx(stateData: Record<string, unknown> = {}): AutomationContext {
  return {
    mcp: new Proxy({} as AutomationContext["mcp"], {
      get: () => {
        throw new Error("mcp not available");
      },
    }),
    state: {
      get: async <T = unknown>(key: string) => stateData[key] as T | undefined,
      set: async () => {
        throw new Error("read-only");
      },
      delete: async () => {
        throw new Error("read-only");
      },
      all: async () => ({ ...stateData }),
    },
    repoRoot: "/test/repo",
    signal: AbortSignal.timeout(30_000),
    workItem: { id: "#42", issueNumber: 42, prNumber: 42, branch: "feat/test", phase: "qa" },
    config: {},
    findWorkItemByBranch: () => null,
    findWorkItemByIssue: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    emit: () => {},
  };
}

describe("cleanup automation module", () => {
  test("returns bye-and-untrack with session IDs from state", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({
      session_id: "sess-impl-1",
      review_session_id: "sess-review-1",
      qa_session_id: "sess-qa-1",
      worktree_path: "/some/path",
      triage_scrutiny: "high",
    });

    const result = await cleanup.fn(makeEvent(), ctx);

    expect(result.action).toBe("bye-and-untrack");
    if (result.action === "bye-and-untrack") {
      expect(result.sessionIds).toHaveLength(3);
      expect(result.sessionIds).toContain("sess-impl-1");
      expect(result.sessionIds).toContain("sess-review-1");
      expect(result.sessionIds).toContain("sess-qa-1");
    }
  });

  test("returns none when mergeSha is missing", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({ session_id: "sess-1" });
    const result = await cleanup.fn(makeEvent({ mergeSha: undefined }), ctx);

    expect(result.action).toBe("none");
    if (result.action === "none") {
      expect(result.reason).toContain("mergeSha");
    }
  });

  test("returns none when mergeSha is empty string", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({ session_id: "sess-1" });
    const result = await cleanup.fn(makeEvent({ mergeSha: "" }), ctx);

    expect(result.action).toBe("none");
  });

  test("returns none when prNumber is missing", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({ session_id: "sess-1" });
    const result = await cleanup.fn(makeEvent({ prNumber: undefined }), ctx);

    expect(result.action).toBe("none");
    if (result.action === "none") {
      expect(result.reason).toContain("prNumber");
    }
  });

  test("returns none when no session IDs in state", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({ worktree_path: "/path", triage_scrutiny: "low" });
    const result = await cleanup.fn(makeEvent(), ctx);

    expect(result.action).toBe("none");
    if (result.action === "none") {
      expect(result.reason).toContain("no session IDs");
    }
  });

  test("skips pending session IDs", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({
      session_id: "sess-impl-1",
      qa_session_id: "pending:1234567890",
    });

    const result = await cleanup.fn(makeEvent(), ctx);

    expect(result.action).toBe("bye-and-untrack");
    if (result.action === "bye-and-untrack") {
      expect(result.sessionIds).toEqual(["sess-impl-1"]);
    }
  });

  test("skips empty string session IDs", async () => {
    const cleanup = await loadCleanup();
    const ctx = makeCtx({
      session_id: "sess-impl-1",
      repair_session_id: "",
    });

    const result = await cleanup.fn(makeEvent(), ctx);

    expect(result.action).toBe("bye-and-untrack");
    if (result.action === "bye-and-untrack") {
      expect(result.sessionIds).toEqual(["sess-impl-1"]);
    }
  });

  test("subscribes to pr.merged event", async () => {
    const cleanup = await loadCleanup();
    expect(cleanup.events).toEqual(["pr.merged"]);
  });

  test("module name is cleanup", async () => {
    const cleanup = await loadCleanup();
    expect(cleanup.name).toBe("cleanup");
  });
});
