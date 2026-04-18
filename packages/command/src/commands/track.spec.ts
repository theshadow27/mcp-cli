import { describe, expect, test } from "bun:test";
import type { IpcMethod, IpcMethodResult, Manifest, WorkItem } from "@mcp-cli/core";
import { loadManifest } from "@mcp-cli/core";
import type { TrackDeps } from "./track";
import { cmdTrack, cmdTracked, cmdUntrack, formatWorkItemRow } from "./track";

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function makeDeps(overrides: Partial<Record<IpcMethod, unknown>> = {}): TrackDeps {
  return {
    ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
      if (method in overrides) {
        const fn = overrides[method];
        return (typeof fn === "function" ? fn(params) : fn) as IpcMethodResult[M];
      }
      throw new Error(`Unexpected IPC call: ${method}`);
    },
    exit: (code: number): never => {
      throw new ExitError(code);
    },
    loadManifest: () => null,
  };
}

const realManifestLoader = (dir: string): Manifest | null => {
  try {
    return loadManifest(dir)?.manifest ?? null;
  } catch {
    return null;
  }
};

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "#1135",
    issueNumber: 1135,
    branch: "feat/issue-1135-cleanup",
    prNumber: null,
    prState: "open",
    prUrl: null,
    ciStatus: "passed",
    ciRunId: null,
    ciSummary: null,
    reviewStatus: "none",
    phase: "impl",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("cmdTrack", () => {
  test("tracks a number", async () => {
    let captured: unknown;
    const item = makeWorkItem();
    const deps = makeDeps({
      trackWorkItem: (params: unknown) => {
        captured = params;
        return item;
      },
    });

    await cmdTrack(["1135"], deps);
    expect(captured).toEqual({ number: 1135 });
  });

  test("tracks a branch", async () => {
    let captured: unknown;
    const item = makeWorkItem({ id: "branch:feat/test", branch: "feat/test" });
    const deps = makeDeps({
      trackWorkItem: (params: unknown) => {
        captured = params;
        return item;
      },
    });

    await cmdTrack(["--branch", "feat/test"], deps);
    expect(captured).toEqual({ branch: "feat/test" });
  });

  test("rejects missing args", async () => {
    const deps = makeDeps();
    // No args — prints help, doesn't exit
    await cmdTrack([], deps);
  });

  test("rejects invalid number", async () => {
    const deps = makeDeps();
    await expect(cmdTrack(["abc"], deps)).rejects.toThrow("exit(1)");
  });

  test("rejects zero", async () => {
    const deps = makeDeps();
    await expect(cmdTrack(["0"], deps)).rejects.toThrow("exit(1)");
  });

  test("rejects missing branch name", async () => {
    const deps = makeDeps();
    await expect(cmdTrack(["--branch"], deps)).rejects.toThrow("exit(1)");
  });

  test("handles IPC error gracefully", async () => {
    const deps = makeDeps({
      trackWorkItem: () => {
        throw new Error("daemon unavailable");
      },
    });
    await expect(cmdTrack(["1135"], deps)).rejects.toThrow("exit(1)");
  });
});

describe("cmdUntrack", () => {
  test("untracks a number", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["1135"], deps);
    expect(captured).toEqual({ number: 1135 });
  });

  test("untracks a branch", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["--branch", "feat/test"], deps);
    expect(captured).toEqual({ branch: "feat/test" });
  });

  test("handles not tracked", async () => {
    const deps = makeDeps({
      untrackWorkItem: () => ({ ok: true, deleted: false }),
    });

    // Should not throw
    await cmdUntrack(["999"], deps);
  });

  test("handles branch not tracked", async () => {
    const deps = makeDeps({
      untrackWorkItem: () => ({ ok: true, deleted: false }),
    });

    await cmdUntrack(["--branch", "feat/nonexistent"], deps);
  });

  test("rejects invalid number", async () => {
    const deps = makeDeps();
    await expect(cmdUntrack(["abc"], deps)).rejects.toThrow("exit(1)");
  });

  test("rejects missing branch name", async () => {
    const deps = makeDeps();
    await expect(cmdUntrack(["--branch"], deps)).rejects.toThrow("exit(1)");
  });

  test("prints help with no args", async () => {
    const deps = makeDeps();
    await cmdUntrack([], deps);
  });

  test("handles IPC error gracefully", async () => {
    const deps = makeDeps({
      untrackWorkItem: () => {
        throw new Error("daemon unavailable");
      },
    });
    await expect(cmdUntrack(["1135"], deps)).rejects.toThrow("exit(1)");
  });
});

describe("cmdTracked", () => {
  test("outputs JSON with --json", async () => {
    const items = [makeWorkItem()];
    const deps = makeDeps({ listWorkItems: items });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await cmdTracked(["--json"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(logs.join(""));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("#1135");
  });

  test("outputs table for human-readable", async () => {
    const items = [makeWorkItem(), makeWorkItem({ id: "#1120", prNumber: 1131, phase: "qa", ciStatus: "running" })];
    const deps = makeDeps({ listWorkItems: items });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await cmdTracked([], deps);
    } finally {
      console.log = origLog;
    }

    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("#1135");
    expect(logs[1]).toContain("#1120");
  });

  test("shows empty message when no items", async () => {
    const deps = makeDeps({ listWorkItems: [] });

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      await cmdTracked([], deps);
    } finally {
      console.error = origErr;
    }

    expect(errors[0]).toContain("No tracked work items");
  });

  test("passes phase filter", async () => {
    let captured: unknown;
    const deps = makeDeps({
      listWorkItems: (params: unknown) => {
        captured = params;
        return [];
      },
    });

    await cmdTracked(["--phase", "qa"], deps);
    expect(captured).toEqual({ phase: "qa" });
  });

  test("rejects --phase with no value", async () => {
    const deps = makeDeps();
    await expect(cmdTracked(["--phase"], deps)).rejects.toThrow("exit(1)");
  });

  test("rejects --phase followed by another flag", async () => {
    const deps = makeDeps();
    await expect(cmdTracked(["--phase", "--json"], deps)).rejects.toThrow("exit(1)");
  });

  test("rejects unknown phase value", async () => {
    const deps = makeDeps();
    await expect(cmdTracked(["--phase", "bogus"], deps)).rejects.toThrow("exit(1)");
  });

  test("handles IPC error gracefully", async () => {
    const deps = makeDeps({
      listWorkItems: () => {
        throw new Error("daemon unavailable");
      },
    });
    await expect(cmdTracked(["--json"], deps)).rejects.toThrow("exit(1)");
  });
});

describe("formatWorkItemRow", () => {
  test("formats a work item with all fields", () => {
    const item = makeWorkItem({
      prNumber: 1135,
      ciStatus: "passed",
      reviewStatus: "approved",
      phase: "qa",
    });
    const row = formatWorkItemRow(item);
    expect(row).toContain("#1135");
    expect(row).toContain("PR #1135");
    expect(row).toContain("CI");
    expect(row).toContain("phase: qa");
  });

  test("formats item without PR", () => {
    const item = makeWorkItem({ prNumber: null });
    const row = formatWorkItemRow(item);
    expect(row).toContain("#1135");
    expect(row).not.toContain("PR #");
  });

  test("formats various CI statuses", () => {
    for (const status of ["none", "pending", "running", "passed", "failed"] as const) {
      const item = makeWorkItem({ ciStatus: status });
      const row = formatWorkItemRow(item);
      expect(row).toContain("CI");
    }
  });

  test("formats various review statuses", () => {
    for (const status of ["none", "pending", "approved", "changes_requested"] as const) {
      const item = makeWorkItem({ reviewStatus: status });
      const row = formatWorkItemRow(item);
      expect(row).toContain("review:");
    }
  });

  test("includes branch when present", () => {
    const item = makeWorkItem({ branch: "feat/issue-1135-cleanup" });
    const row = formatWorkItemRow(item);
    expect(row).toContain("feat/issue-1135-cleanup");
  });

  describe("manifest integration", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");

    function withManifestDir(manifestYaml: string, run: (dir: string) => Promise<void>): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), "mcx-track-manifest-"));
      writeFileSync(join(dir, ".mcx.yaml"), manifestYaml);
      return run(dir).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
    }

    test("cmdTrack passes initialPhase from manifest", async () => {
      let captured: unknown;
      const item = makeWorkItem();

      await withManifestDir(
        "version: 1\ninitial: plan\nphases:\n  plan: { source: ./p.ts, next: [build] }\n  build: { source: ./b.ts }\n",
        (dir) => {
          const deps = {
            ...makeDeps({
              trackWorkItem: (params: unknown) => {
                captured = params;
                return item;
              },
            }),
            loadManifest: realManifestLoader,
            cwd: () => dir,
          };
          return cmdTrack(["1135"], deps);
        },
      );
      expect(captured).toEqual({ number: 1135, initialPhase: "plan" });
    });

    test("cmdTracked --json annotates phaseValid from manifest", async () => {
      const items = [
        makeWorkItem({ phase: "plan" as unknown as WorkItem["phase"] }),
        makeWorkItem({ id: "#2", phase: "impl" }),
      ];

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        await withManifestDir(
          "version: 1\ninitial: plan\nphases:\n  plan: { source: ./p.ts, next: [build] }\n  build: { source: ./b.ts }\n",
          (dir) => {
            const deps = { ...makeDeps({ listWorkItems: items }), loadManifest: realManifestLoader, cwd: () => dir };
            return cmdTracked(["--json"], deps);
          },
        );
      } finally {
        console.log = origLog;
      }
      const parsed = JSON.parse(logs.join(""));
      expect(parsed[0].phaseValid).toBe(true);
      expect(parsed[1].phaseValid).toBe(false);
    });

    test("cmdTracked --phase warns when phase is not declared, but still queries", async () => {
      let captured: unknown;
      const errs: string[] = [];
      const origErr = console.error;
      console.error = (msg: string) => errs.push(msg);
      try {
        await withManifestDir(
          "version: 1\ninitial: plan\nphases:\n  plan: { source: ./p.ts, next: [build] }\n  build: { source: ./b.ts }\n",
          (dir) => {
            const deps = {
              ...makeDeps({
                listWorkItems: (params: unknown) => {
                  captured = params;
                  return [];
                },
              }),
              loadManifest: realManifestLoader,
              cwd: () => dir,
            };
            return cmdTracked(["--phase", "impl"], deps);
          },
        );
      } finally {
        console.error = origErr;
      }
      expect(captured).toEqual({ phase: "impl" });
      expect(errs.some((e) => e.includes('phase "impl" is not declared'))).toBe(true);
    });
  });
});
