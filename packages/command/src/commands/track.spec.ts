import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMethod, IpcMethodResult, Manifest, TrackableField, WorkItem } from "@mcp-cli/core";
import {
  appendTransitionLog,
  clearFindGitRootCache,
  createAliasState,
  loadManifest,
  normalizeStateRoot,
  readAllTransitions,
  resolveRealpath,
  workItemStateNamespace,
  workItemStateRoot,
} from "@mcp-cli/core";
import type { TrackDeps } from "./track";
import { cmdTrack, cmdTracked, cmdUntrack, formatWorkItemRow, parseMetadataFlags } from "./track";

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
    // dotw-ignore test-empty-catch: parse-probe — fallback on expected parse failure
  } catch {
    return null;
  }
};

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "#1135",
    domainId: 0,
    issueNumber: 1135,
    branch: "feat/issue-1135-cleanup",
    prNumber: null,
    prState: "open",
    prUrl: null,
    ciStatus: "passed",
    ciRunId: null,
    ciSummary: null,
    reviewStatus: "none",
    mergeStateStatus: null,
    phase: "impl",
    automationOverrides: null,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    version: 1,
    ...overrides,
  };
}

describe("parseMetadataFlags", () => {
  const enumField: TrackableField = {
    key: "scrutiny",
    baseType: "enum",
    optional: false,
    enumValues: ["low", "medium", "high"],
    repeatable: false,
    required: false,
    defaultValue: undefined,
  };

  const repeatableField: TrackableField = {
    key: "bundled_with",
    baseType: "string",
    optional: false,
    enumValues: null,
    repeatable: true,
    required: false,
    defaultValue: undefined,
  };

  const requiredField: TrackableField = {
    key: "priority",
    baseType: "string",
    optional: false,
    enumValues: null,
    repeatable: false,
    required: true,
    defaultValue: undefined,
  };

  test("parses valid enum value", () => {
    const { metadata, errors } = parseMetadataFlags(["42", "--scrutiny", "high"], [enumField]);
    expect(errors).toHaveLength(0);
    expect(metadata.get("scrutiny")).toBe("high");
  });

  test("rejects invalid enum value", () => {
    const { errors } = parseMetadataFlags(["42", "--scrutiny", "extreme"], [enumField]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("extreme");
    expect(errors[0]).toContain("low, medium, high");
  });

  test("collects repeatable values into comma-joined string", () => {
    const { metadata, errors } = parseMetadataFlags(
      ["42", "--bundled-with", "100", "--bundled-with", "200"],
      [repeatableField],
    );
    expect(errors).toHaveLength(0);
    expect(metadata.get("bundled_with")).toBe("100,200");
  });

  test("rejects unknown flags when trackable fields exist", () => {
    const { errors } = parseMetadataFlags(["42", "--bogus", "val"], [enumField]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unknown metadata flag");
  });

  test("ignores unknown flags when no trackable fields", () => {
    const { errors } = parseMetadataFlags(["42", "--bogus", "val"], []);
    expect(errors).toHaveLength(0);
  });

  test("skips built-in flags", () => {
    const { metadata, errors } = parseMetadataFlags(["42", "--branch", "feat/x", "--scrutiny", "low"], [enumField]);
    expect(errors).toHaveLength(0);
    expect(metadata.get("scrutiny")).toBe("low");
    expect(metadata.has("branch")).toBe(false);
  });

  test("skips --phase and --json flags", () => {
    const { metadata, errors } = parseMetadataFlags(
      ["42", "--phase", "impl", "--json", "--scrutiny", "low"],
      [enumField],
    );
    expect(errors).toHaveLength(0);
    expect(metadata.get("scrutiny")).toBe("low");
    expect(metadata.has("phase")).toBe(false);
    expect(metadata.has("json")).toBe(false);
  });

  test("errors on missing required field", () => {
    const { errors } = parseMetadataFlags(["42"], [requiredField]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("required");
    expect(errors[0]).toContain("priority");
  });

  test("converts hyphens to underscores in flag names", () => {
    const { metadata, errors } = parseMetadataFlags(["42", "--bundled-with", "100"], [repeatableField]);
    expect(errors).toHaveLength(0);
    expect(metadata.has("bundled_with")).toBe(true);
  });

  test("errors when flag has no value", () => {
    const { errors } = parseMetadataFlags(["42", "--scrutiny"], [enumField]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("requires a value");
  });

  test("marks consumed indices correctly", () => {
    const { consumed } = parseMetadataFlags(
      ["42", "--scrutiny", "high", "--bundled-with", "100"],
      [enumField, repeatableField],
    );
    expect(consumed.has(0)).toBe(false);
    expect(consumed.has(1)).toBe(true);
    expect(consumed.has(2)).toBe(true);
    expect(consumed.has(3)).toBe(true);
    expect(consumed.has(4)).toBe(true);
  });
});

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
    expect(captured).toEqual({ number: 1135, cwd: expect.any(String), repoRoot: expect.any(String) });
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
    expect(captured).toEqual({ branch: "feat/test", cwd: expect.any(String), repoRoot: expect.any(String) });
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
    expect(captured).toEqual({ number: 1135, cwd: expect.any(String) });
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
    expect(captured).toEqual({ branch: "feat/test", cwd: expect.any(String) });
  });

  test("untracks branch:NAME format emitted by mcx tracked --json", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["branch:feat/test"], deps);
    expect(captured).toEqual({ branch: "feat/test", cwd: expect.any(String) });
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

  test("untracks #NNNN format", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["#1135"], deps);
    expect(captured).toEqual({ number: 1135, cwd: expect.any(String) });
  });

  test("untracks pr:NNNN format", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["pr:1186"], deps);
    expect(captured).toEqual({ number: 1186, cwd: expect.any(String) });
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

function makeListResult(items: WorkItem[], hiddenCount = 0) {
  return { items, hiddenCount };
}

describe("cmdTracked", () => {
  test("outputs JSON with --json", async () => {
    const items = [makeWorkItem()];
    const deps = makeDeps({ listWorkItems: makeListResult(items) });

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
    const deps = makeDeps({ listWorkItems: makeListResult(items) });

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

  test("shows empty message when no items and no hidden", async () => {
    const deps = makeDeps({ listWorkItems: makeListResult([]) });

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

  test("shows hidden hint on stderr when stale items are suppressed", async () => {
    const deps = makeDeps({ listWorkItems: makeListResult([], 3) });

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      await cmdTracked([], deps);
    } finally {
      console.error = origErr;
    }

    expect(errors.join("")).toContain("3 stale done items hidden (--include-archived to show)");
  });

  test("shows hidden hint after JSON output when stale items suppressed", async () => {
    const deps = makeDeps({ listWorkItems: makeListResult([makeWorkItem()], 2) });

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => errors.push(msg);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await cmdTracked(["--json"], deps);
    } finally {
      console.error = origErr;
      console.log = origLog;
    }

    expect(logs.join("")).toContain("#1135");
    expect(errors.join("")).toContain("2 stale done items hidden (--include-archived to show)");
  });

  test("passes phase filter with explicit includeArchived:false", async () => {
    let captured: unknown;
    const deps = makeDeps({
      listWorkItems: (params: unknown) => {
        captured = params;
        return makeListResult([]);
      },
    });

    await cmdTracked(["--phase", "qa"], deps);
    expect(captured).toEqual({ phase: "qa", includeArchived: false, cwd: expect.any(String) });
  });

  test("passes includeArchived:true when --include-archived flag is set", async () => {
    let captured: unknown;
    const deps = makeDeps({
      listWorkItems: (params: unknown) => {
        captured = params;
        return makeListResult([]);
      },
    });

    await cmdTracked(["--include-archived"], deps);
    expect(captured).toEqual({ includeArchived: true, cwd: expect.any(String) });
  });

  test("passes includeArchived:false when flag is absent", async () => {
    let captured: unknown;
    const deps = makeDeps({
      listWorkItems: (params: unknown) => {
        captured = params;
        return makeListResult([]);
      },
    });

    await cmdTracked([], deps);
    expect(captured).toEqual({ includeArchived: false, cwd: expect.any(String) });
  });

  test("combines --include-archived with --phase", async () => {
    let captured: unknown;
    const deps = makeDeps({
      listWorkItems: (params: unknown) => {
        captured = params;
        return makeListResult([]);
      },
    });

    await cmdTracked(["--phase", "done", "--include-archived"], deps);
    expect(captured).toEqual({ phase: "done", includeArchived: true, cwd: expect.any(String) });
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
      expect(captured).toEqual({
        number: 1135,
        initialPhase: "plan",
        cwd: expect.any(String),
        repoRoot: expect.any(String),
      });
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
            const deps = {
              ...makeDeps({ listWorkItems: makeListResult(items) }),
              loadManifest: realManifestLoader,
              cwd: () => dir,
            };
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
                  return makeListResult([]);
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
      expect(captured).toEqual({ phase: "impl", includeArchived: false, cwd: expect.any(String) });
      expect(errs.some((e) => e.includes('phase "impl" is not declared'))).toBe(true);
    });

    test("cmdTrack persists metadata via aliasStateSet", async () => {
      const item = makeWorkItem({ id: "#42" });
      const stateCalls: Array<{ method: string; params: unknown }> = [];

      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        '  scrutiny: { type: "enum[low,medium,high]", track: true }',
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      await withManifestDir(MANIFEST_YAML, (dir) => {
        const deps: TrackDeps = {
          ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
            if (method === "trackWorkItem") return item as IpcMethodResult[M];
            if (method === "aliasStateAll") return { entries: {} } as IpcMethodResult[M];
            if (method === "aliasStateSet") {
              stateCalls.push({ method, params: params as Record<string, unknown> });
              return { ok: true } as IpcMethodResult[M];
            }
            throw new Error(`Unexpected IPC call: ${method}`);
          },
          exit: (code: number): never => {
            throw new ExitError(code);
          },
          loadManifest: realManifestLoader,
          cwd: () => dir,
        };
        return cmdTrack(["42", "--scrutiny", "high"], deps);
      });

      expect(stateCalls).toHaveLength(1);
      expect(stateCalls[0].params).toEqual({
        repoRoot: expect.any(String),
        namespace: "workitem:#42",
        key: "scrutiny",
        value: "high",
      });
    });

    test("cmdTrack rejects invalid enum value", async () => {
      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        '  scrutiny: { type: "enum[low,medium,high]", track: true }',
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      await expect(
        withManifestDir(MANIFEST_YAML, (dir) => {
          const deps: TrackDeps = {
            ...makeDeps({ trackWorkItem: () => makeWorkItem() }),
            loadManifest: realManifestLoader,
            cwd: () => dir,
          };
          return cmdTrack(["42", "--scrutiny", "extreme"], deps);
        }),
      ).rejects.toThrow("exit(1)");
    });

    test("cmdTrack rejects unknown metadata flag when trackable fields exist", async () => {
      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        '  scrutiny: { type: "enum[low,medium,high]", track: true }',
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      await expect(
        withManifestDir(MANIFEST_YAML, (dir) => {
          const deps: TrackDeps = {
            ...makeDeps({ trackWorkItem: () => makeWorkItem() }),
            loadManifest: realManifestLoader,
            cwd: () => dir,
          };
          return cmdTrack(["42", "--nonexistent", "val"], deps);
        }),
      ).rejects.toThrow("exit(1)");
    });

    test("cmdTrack handles repeatable fields", async () => {
      const item = makeWorkItem({ id: "#42" });
      const stateCalls: Array<{ key: string; value: unknown }> = [];

      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        "  bundled_with: { type: string, track: true, repeatable: true }",
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      await withManifestDir(MANIFEST_YAML, (dir) => {
        const deps: TrackDeps = {
          ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
            if (method === "trackWorkItem") return item as IpcMethodResult[M];
            if (method === "aliasStateAll") return { entries: {} } as IpcMethodResult[M];
            if (method === "aliasStateSet") {
              const p = params as Record<string, unknown>;
              stateCalls.push({ key: p.key as string, value: p.value });
              return { ok: true } as IpcMethodResult[M];
            }
            throw new Error(`Unexpected IPC call: ${method}`);
          },
          exit: (code: number): never => {
            throw new ExitError(code);
          },
          loadManifest: realManifestLoader,
          cwd: () => dir,
        };
        return cmdTrack(["42", "--bundled-with", "1001", "--bundled-with", "1002"], deps);
      });

      expect(stateCalls).toHaveLength(1);
      expect(stateCalls[0].key).toBe("bundled_with");
      expect(stateCalls[0].value).toBe("1001,1002");
    });

    test("cmdTrack re-track preserves prior metadata (does not overwrite with defaults)", async () => {
      const item = makeWorkItem({ id: "#42" });
      const stateCalls: Array<{ key: string; value: unknown }> = [];

      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        '  scrutiny: { type: "enum[low,medium,high]", track: true, default: medium }',
        "  bundled_with: { type: string, track: true, repeatable: true }",
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      await withManifestDir(MANIFEST_YAML, (dir) => {
        const deps: TrackDeps = {
          ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
            if (method === "trackWorkItem") return item as IpcMethodResult[M];
            if (method === "aliasStateAll") return { entries: { scrutiny: "high" } } as IpcMethodResult[M];
            if (method === "aliasStateSet") {
              const p = params as Record<string, unknown>;
              stateCalls.push({ key: p.key as string, value: p.value });
              return { ok: true } as IpcMethodResult[M];
            }
            throw new Error(`Unexpected IPC call: ${method}`);
          },
          exit: (code: number): never => {
            throw new ExitError(code);
          },
          loadManifest: realManifestLoader,
          cwd: () => dir,
        };
        return cmdTrack(["42", "--bundled-with", "1001"], deps);
      });

      expect(stateCalls).toHaveLength(1);
      expect(stateCalls[0].key).toBe("bundled_with");
      expect(stateCalls[0].value).toBe("1001");
    });

    test("cmdTrack persists default value on first track (no existing state)", async () => {
      const item = makeWorkItem({ id: "#42" });
      const stateCalls: Array<{ key: string; value: unknown }> = [];

      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        '  scrutiny: { type: "enum[low,medium,high]", track: true, default: medium }',
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      await withManifestDir(MANIFEST_YAML, (dir) => {
        const deps: TrackDeps = {
          ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
            if (method === "trackWorkItem") return item as IpcMethodResult[M];
            if (method === "aliasStateAll") return { entries: {} } as IpcMethodResult[M];
            if (method === "aliasStateSet") {
              const p = params as Record<string, unknown>;
              stateCalls.push({ key: p.key as string, value: p.value });
              return { ok: true } as IpcMethodResult[M];
            }
            throw new Error(`Unexpected IPC call: ${method}`);
          },
          exit: (code: number): never => {
            throw new ExitError(code);
          },
          loadManifest: realManifestLoader,
          cwd: () => dir,
        };
        return cmdTrack(["42"], deps);
      });

      expect(stateCalls).toHaveLength(1);
      expect(stateCalls[0].key).toBe("scrutiny");
      expect(stateCalls[0].value).toBe("medium");
    });

    test("cmdTracked --json includes state for trackable fields", async () => {
      const items = [makeWorkItem({ id: "#42" })];

      const MANIFEST_YAML = [
        "version: 1",
        "initial: plan",
        "state:",
        '  scrutiny: { type: "enum[low,medium,high]", track: true }',
        "phases:",
        "  plan: { source: ./p.ts, next: [build] }",
        "  build: { source: ./b.ts }",
      ].join("\n");

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        await withManifestDir(MANIFEST_YAML, (dir) => {
          const deps: TrackDeps = {
            ipcCall: async <M extends IpcMethod>(method: M, _params?: unknown): Promise<IpcMethodResult[M]> => {
              if (method === "listWorkItems") return makeListResult(items as WorkItem[]) as IpcMethodResult[M];
              if (method === "aliasStateAll")
                return { entries: { scrutiny: "high", session_id: "sess-1" } } as IpcMethodResult[M];
              throw new Error(`Unexpected IPC call: ${method}`);
            },
            exit: (code: number): never => {
              throw new ExitError(code);
            },
            loadManifest: realManifestLoader,
            cwd: () => dir,
          };
          return cmdTracked(["--json"], deps);
        });
      } finally {
        console.log = origLog;
      }

      const parsed = JSON.parse(logs.join(""));
      expect(parsed[0].state).toEqual({ scrutiny: "high" });
      expect(parsed[0].state.session_id).toBeUndefined();
    });
  });
});

describe("pruneStaleHistory integration (#2463)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "track-prune-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-tracking an issue prunes stale transition log entries", async () => {
    const logPath = join(dir, ".mcx", "transitions.jsonl");

    appendTransitionLog(logPath, {
      ts: "2026-05-01T00:00:00Z",
      workItemId: "#2135",
      from: null,
      to: "impl",
      status: "committed",
    });
    appendTransitionLog(logPath, {
      ts: "2026-05-01T01:00:00Z",
      workItemId: "#2135",
      from: "impl",
      to: "triage",
      status: "committed",
    });
    appendTransitionLog(logPath, {
      ts: "2026-05-01T00:30:00Z",
      workItemId: "#99",
      from: null,
      to: "impl",
      status: "committed",
    });

    const freshCreatedAt = "2026-05-27 14:49:10";
    const item = makeWorkItem({
      id: "#2135",
      issueNumber: 2135,
      createdAt: freshCreatedAt,
      version: 1,
    });

    const deps: TrackDeps = {
      ipcCall: async <M extends IpcMethod>(method: M): Promise<IpcMethodResult[M]> => {
        if (method === "trackWorkItem") return item as IpcMethodResult[M];
        throw new Error(`Unexpected IPC call: ${method}`);
      },
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      cwd: () => dir,
    };

    await cmdTrack(["2135"], deps);

    const remaining = readAllTransitions(logPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].workItemId).toBe("#99");
  });

  test("re-tracking a branch prunes stale transition log entries", async () => {
    const logPath = join(dir, ".mcx", "transitions.jsonl");

    appendTransitionLog(logPath, {
      ts: "2026-04-01T00:00:00Z",
      workItemId: "branch:feat/test",
      from: null,
      to: "impl",
      status: "committed",
    });

    const freshCreatedAt = "2026-05-01T00:00:00Z";
    const item = makeWorkItem({
      id: "branch:feat/test",
      branch: "feat/test",
      createdAt: freshCreatedAt,
      version: 1,
    });

    const deps: TrackDeps = {
      ipcCall: async <M extends IpcMethod>(method: M): Promise<IpcMethodResult[M]> => {
        if (method === "trackWorkItem") return item as IpcMethodResult[M];
        throw new Error(`Unexpected IPC call: ${method}`);
      },
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      cwd: () => dir,
    };

    await cmdTrack(["--branch", "feat/test"], deps);

    const remaining = readAllTransitions(logPath);
    expect(remaining).toHaveLength(0);
  });

  test("preserves current-incarnation entries when re-tracking existing item", async () => {
    const logPath = join(dir, ".mcx", "transitions.jsonl");

    const createdAt = "2026-05-01T00:00:00Z";
    appendTransitionLog(logPath, {
      ts: "2026-05-01T00:01:00Z",
      workItemId: "#42",
      from: null,
      to: "impl",
      status: "committed",
    });

    const item = makeWorkItem({
      id: "#42",
      issueNumber: 42,
      createdAt,
      version: 2,
    });

    const deps: TrackDeps = {
      ipcCall: async <M extends IpcMethod>(method: M): Promise<IpcMethodResult[M]> => {
        if (method === "trackWorkItem") return item as IpcMethodResult[M];
        throw new Error(`Unexpected IPC call: ${method}`);
      },
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      cwd: () => dir,
    };

    await cmdTrack(["42"], deps);

    const remaining = readAllTransitions(logPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].workItemId).toBe("#42");
  });

  test("no-op when log file does not exist", async () => {
    const item = makeWorkItem();
    const deps: TrackDeps = {
      ipcCall: async <M extends IpcMethod>(method: M): Promise<IpcMethodResult[M]> => {
        if (method === "trackWorkItem") return item as IpcMethodResult[M];
        throw new Error(`Unexpected IPC call: ${method}`);
      },
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      cwd: () => dir,
    };

    await cmdTrack(["1135"], deps);
  });

  test("createdAt in SQLite format (no TZ) is parsed as UTC, not local time", async () => {
    const logPath = join(dir, ".mcx", "transitions.jsonl");

    // Entry 30 minutes AFTER createdAt — must be preserved (current incarnation).
    // If createdAt were parsed as local time on a UTC-4 machine, the cutoff
    // would shift +4h and this entry would be incorrectly pruned.
    const createdAt = "2026-06-01 12:00:00";
    appendTransitionLog(logPath, {
      ts: "2026-06-01T12:30:00Z",
      workItemId: "#77",
      from: null,
      to: "impl",
      status: "committed",
    });

    // Stale entry from prior sprint — must be pruned.
    appendTransitionLog(logPath, {
      ts: "2026-05-01T00:00:00Z",
      workItemId: "#77",
      from: null,
      to: "impl",
      status: "committed",
    });

    const item = makeWorkItem({
      id: "#77",
      issueNumber: 77,
      createdAt,
      version: 1,
    });

    const deps: TrackDeps = {
      ipcCall: async <M extends IpcMethod>(method: M): Promise<IpcMethodResult[M]> => {
        if (method === "trackWorkItem") return item as IpcMethodResult[M];
        throw new Error(`Unexpected IPC call: ${method}`);
      },
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      cwd: () => dir,
    };

    await cmdTrack(["77"], deps);

    const remaining = readAllTransitions(logPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ts).toBe("2026-06-01T12:30:00Z");
  });
});

/**
 * R2 regression: untrack must clean up the namespace the daemon actually wrote.
 *
 * `persistMetadata` has always used `item.id` (the stored id from the track response), while
 * `cleanupMetadata` was handed a spelling reconstructed from what the user typed — `#42` /
 * `branch:foo`. Domain-qualified ids make those different namespaces, so cleanup deleted
 * nothing and every untracked item leaked its scratchpad forever. The two halves of the same
 * command disagreed with each other.
 *
 * The fix is to clean up using the canonical id the daemon reports deleting, because after
 * the row is gone the CLI has no other way to learn it.
 */
describe("cmdUntrack — phase-state cleanup uses the canonical id (#3037 R2)", () => {
  function capturingDeps(deletedId: string) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const deps = makeDeps({
      untrackWorkItem: () => ({ ok: true, deleted: true, id: deletedId }),
      aliasStateAll: (params: unknown) => {
        calls.push({ method: "aliasStateAll", params: params as Record<string, unknown> });
        return { entries: { session_id: "abc" } };
      },
      aliasStateDelete: (params: unknown) => {
        calls.push({ method: "aliasStateDelete", params: params as Record<string, unknown> });
        return { ok: true, deleted: true };
      },
    });
    return { deps, calls };
  }

  test("a number-untrack cleans the domain-qualified namespace, not the typed one", async () => {
    const { deps, calls } = capturingDeps("d1:#1135");
    await cmdUntrack(["1135"], deps);

    const namespaces = calls.map((c) => c.params.namespace);
    expect(namespaces).toEqual(["workitem:d1:#1135", "workitem:d1:#1135"]);
    // The spelling the user typed must never be the one we delete from.
    for (const ns of namespaces) expect(ns).not.toBe("workitem:#1135");
  });

  test("a branch-untrack does the same", async () => {
    const { deps, calls } = capturingDeps("d2:branch:feat/test");
    await cmdUntrack(["--branch", "feat/test"], deps);

    expect(calls.map((c) => c.params.namespace)).toEqual([
      "workitem:d2:branch:feat/test",
      "workitem:d2:branch:feat/test",
    ]);
  });

  test("the key found in the namespace is the key deleted from it", async () => {
    const { deps, calls } = capturingDeps("d1:#1135");
    await cmdUntrack(["1135"], deps);

    const del = calls.find((c) => c.method === "aliasStateDelete");
    expect(del?.params.key).toBe("session_id");
  });

  test("no id in the response means no cleanup attempted — never a guessed namespace", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      untrackWorkItem: () => ({ ok: true, deleted: true }),
      aliasStateAll: () => {
        calls.push("aliasStateAll");
        return { entries: {} };
      },
    });
    await cmdUntrack(["1135"], deps);
    expect(calls).toEqual([]);
  });
});

/**
 * The (repo_root, namespace, key) round trip across two independent commands (#3209).
 *
 * These use a **real git repo with a real linked worktree** and a fake that keys rows
 * exactly the way `daemon/src/handlers/work-item.ts` does — through the shared
 * `normalizeStateRoot`. Nothing here asserts that a function returns what
 * a stub was built to return: the write goes through `cmdTrack` and the read through
 * `cmdTracked` / the phase runner's own derivation, and the test fails if those two
 * disagree about the root. That is the failure mode the pre-fix code had and the coverage
 * #3175 shipped could not catch.
 *
 * A **worktree**, not a plain subdirectory, because that is where this actually bit: every
 * mis-keyed row found in the wild (11 of them, all `scrutiny`) was written by `mcx track`
 * from `.claude/worktrees/*`. A worktree carries its own checked-in `.mcx.yaml`, so the
 * manifest resolves and the metadata write proceeds — while `findGitRoot` maps the
 * worktree back to the main checkout, which is the root every reader uses. A plain
 * subdirectory never gets that far: `findManifest` does not walk up, so `--scrutiny` is
 * rejected as an unknown flag before any state is written (#3375).
 */
describe("phase-state round trip from a linked worktree", () => {
  const MANIFEST_YAML = [
    "version: 1",
    "initial: plan",
    "state:",
    '  scrutiny: { type: "enum[low,medium,high]", track: true }',
    "phases:",
    "  plan: { source: ./p.ts, next: [build] }",
    "  build: { source: ./b.ts }",
  ].join("\n");

  /**
   * Model the daemon's alias_state table, including its server-side canonicalization.
   *
   * Calls the same `normalizeStateRoot` the four IPC handlers call rather than restating
   * `resolveRealpath(resolve(...))` — a hand-copy of the daemon's keying is how a test
   * keeps passing while production splits its store (#3376).
   */
  function makeDaemonStore(item: WorkItem) {
    const rows = new Map<string, unknown>();
    const rowKey = (repoRoot: string, ns: string, key: string) => `${normalizeStateRoot(repoRoot)} ${ns} ${key}`;

    const ipcCall = async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
      const p = (params ?? {}) as { repoRoot: string; namespace: string; key?: string; value?: unknown };
      switch (method) {
        case "trackWorkItem":
          return item as IpcMethodResult[M];
        case "listWorkItems":
          return { items: [item], hiddenCount: 0, unassignedCount: 0 } as IpcMethodResult[M];
        case "aliasStateSet":
          rows.set(rowKey(p.repoRoot, p.namespace, p.key ?? ""), p.value);
          return { ok: true } as IpcMethodResult[M];
        case "aliasStateGet":
          return { value: rows.get(rowKey(p.repoRoot, p.namespace, p.key ?? "")) } as IpcMethodResult[M];
        case "aliasStateAll": {
          const prefix = `${normalizeStateRoot(p.repoRoot)} ${p.namespace} `;
          const entries: Record<string, unknown> = {};
          for (const [k, v] of rows) if (k.startsWith(prefix)) entries[k.slice(prefix.length)] = v;
          return { entries } as IpcMethodResult[M];
        }
      }
      throw new Error(`Unexpected IPC call: ${method}`);
    };
    return { rows, ipcCall };
  }

  /** A real repo with `.mcx.yaml` committed, plus a real linked worktree that inherits it. */
  function withWorktree(run: (repo: string, wt: string) => Promise<void>): Promise<void> {
    const repo = mkdtempSync(join(tmpdir(), "mcx-track-roundtrip-"));
    clearFindGitRootCache();
    const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_COMMON_DIR: _c, GIT_INDEX_FILE: _i, ...base } = process.env;
    const env = {
      ...base,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const opts = { env, stdout: "ignore" as const, stderr: "ignore" as const };
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], opts);
    writeFileSync(join(repo, ".mcx.yaml"), MANIFEST_YAML);
    Bun.spawnSync(["git", "-C", repo, "add", ".mcx.yaml"], opts);
    Bun.spawnSync(["git", "-C", repo, "commit", "-m", "init", "-q"], opts);
    const wt = join(repo, ".claude", "worktrees", "w1");
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    const added = Bun.spawnSync(["git", "-C", repo, "worktree", "add", wt, "-b", "wt-branch", "-q"], opts);
    if (added.exitCode !== 0) throw new Error(`git worktree add failed (${added.exitCode})`);
    clearFindGitRootCache();
    return run(repo, wt).finally(() => {
      clearFindGitRootCache();
      rmSync(repo, { recursive: true, force: true });
    });
  }

  const exit = (code: number): never => {
    throw new ExitError(code);
  };

  test("`mcx track --scrutiny` from a worktree is visible to a reader at the main checkout", async () => {
    const item = makeWorkItem({ id: "#42" });
    const { rows, ipcCall } = makeDaemonStore(item);

    await withWorktree(async (repo, wt) => {
      await cmdTrack(["42", "--scrutiny", "high"], {
        ipcCall,
        exit,
        loadManifest: realManifestLoader,
        cwd: () => wt,
      });

      // Read it back the way the phase runner does: its own root derivation, at the main
      // checkout, with no knowledge of where `mcx track` happened to be run from.
      const state = createAliasState({
        repoRoot: workItemStateRoot(repo),
        namespace: workItemStateNamespace(item.id),
        call: ipcCall,
      });
      expect(await state.get<string>("scrutiny")).toBe("high");

      // And the row landed under the main checkout, not under the worktree that wrote it.
      expect([...rows.keys()]).toEqual([`${resolveRealpath(repo)} workitem:#42 scrutiny`]);
    });
  });

  test("`mcx tracked --json` from a worktree sees state written at the main checkout", async () => {
    const item = makeWorkItem({ id: "#42" });
    const { ipcCall } = makeDaemonStore(item);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await withWorktree(async (repo, wt) => {
        // Writer stands at the main checkout (a phase script), reader in the worktree.
        await createAliasState({
          repoRoot: workItemStateRoot(repo),
          namespace: workItemStateNamespace(item.id),
          call: ipcCall,
        }).set("scrutiny", "medium");

        await cmdTracked(["--json"], { ipcCall, exit, loadManifest: realManifestLoader, cwd: () => wt });
      });
    } finally {
      console.log = origLog;
    }

    expect(JSON.parse(logs.join(""))[0].state).toEqual({ scrutiny: "medium" });
  });
});

/**
 * `-d <domain>` redirects the WHOLE command, not just the `work_items` row (#3391 review).
 *
 * The first cut of `-d` plumbed the domain name into the four work-item IPC methods and
 * stopped there, so `mcx track 777 -d otherdom` created the item in `otherdom` while its
 * `--meta` fields were written under the **caller's** domain and the caller's `repo_root`.
 * `repo_root` is part of `alias_state`'s primary key, so a phase script running inside
 * `otherdom` and reading `ctx.state` saw `{}` — the #3209 failure class, reopened by the
 * redirect. The same split ran the other way on `untrack` (leaking the namespace forever)
 * and on `mcx tracked --json` (annotating another domain's items with this repo's fields).
 *
 * These tests hold the ONE invariant that closes it: every root-derived thing the command
 * touches comes from the same domain the row does.
 */
describe("cmdTrack/cmdUntrack/cmdTracked — -d redirects the state root too (#3391)", () => {
  const OTHER_MANIFEST = [
    "version: 1",
    "initial: plan",
    "state:",
    '  scrutiny: { type: "enum[low,medium,high]", track: true }',
    "phases:",
    "  plan: { source: ./p.ts, next: [build] }",
    "  build: { source: ./b.ts }",
  ].join("\n");

  let callerDir: string;
  let otherDir: string;

  beforeEach(() => {
    // Real repos: `workItemStateRoot` resolves through `findGitRoot` and answers with a
    // `__none__` sentinel outside one, which would make both roots compare equal and the
    // assertions below vacuous.
    callerDir = mkdtempSync(join(tmpdir(), "mcx-caller-"));
    otherDir = mkdtempSync(join(tmpdir(), "mcx-otherdom-"));
    // Sanitized env, for the same reason `withWorktree` below does it: under the pre-push
    // hook `GIT_DIR` is set, and `git init -C <tmp>` would honour it and initialize the
    // hook's repo instead. The temp dir then is not a repo, `findGitRoot` (which strips the
    // vars itself) says so, and every root here collapses to the `__none__` sentinel —
    // green in a shell, red under the hook.
    const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_COMMON_DIR: _c, GIT_INDEX_FILE: _i, ...env } = process.env;
    const opts = { env, stdout: "ignore" as const, stderr: "ignore" as const };
    for (const dir of [callerDir, otherDir]) {
      expect(Bun.spawnSync(["git", "-C", dir, "init", "-q"], opts).exitCode).toBe(0);
    }
    clearFindGitRootCache();
    // Only the TARGET domain declares a trackable field. If the command read the caller's
    // checkout the field would be undeclared and `--scrutiny` would be rejected outright.
    writeFileSync(join(otherDir, ".mcx.yaml"), OTHER_MANIFEST);
  });

  afterEach(() => {
    clearFindGitRootCache();
    rmSync(callerDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  });

  /** A daemon fake that keys `alias_state` rows by root the way the real handler does. */
  function makeDeps2(item: WorkItem, seed: Array<[string, string, string, unknown]> = []) {
    const rows = new Map<string, unknown>();
    const key = (root: string, ns: string, k: string) => `${normalizeStateRoot(root)} ${ns} ${k}`;
    for (const [root, ns, k, v] of seed) rows.set(key(root, ns, k), v);
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];

    const deps: TrackDeps = {
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      loadManifest: realManifestLoader,
      cwd: () => callerDir,
      ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
        const p = (params ?? {}) as { repoRoot: string; namespace: string; key?: string; value?: unknown };
        seen.push({ method, params: (params ?? {}) as Record<string, unknown> });
        switch (method) {
          case "domainShow":
            return { id: 2, name: "otherdom", host: null, path: otherDir, createdAt: "" } as IpcMethodResult[M];
          case "trackWorkItem":
            return item as IpcMethodResult[M];
          case "untrackWorkItem":
            return { ok: true, deleted: true, id: item.id } as IpcMethodResult[M];
          case "listWorkItems":
            return { items: [item], hiddenCount: 0, unassignedCount: 0 } as IpcMethodResult[M];
          case "aliasStateSet":
            rows.set(key(p.repoRoot, p.namespace, p.key ?? ""), p.value);
            return { ok: true } as IpcMethodResult[M];
          case "aliasStateDelete":
            return { ok: true, deleted: rows.delete(key(p.repoRoot, p.namespace, p.key ?? "")) } as IpcMethodResult[M];
          case "aliasStateAll": {
            const prefix = `${normalizeStateRoot(p.repoRoot)} ${p.namespace} `;
            const entries: Record<string, unknown> = {};
            for (const [k, v] of rows) if (k.startsWith(prefix)) entries[k.slice(prefix.length)] = v;
            return { entries } as IpcMethodResult[M];
          }
        }
        throw new Error(`Unexpected IPC call: ${method}`);
      },
    };
    return { deps, rows, seen };
  }

  test("track -d writes --meta under the TARGET domain's root, not the caller's", async () => {
    const item = makeWorkItem({ id: "d2:#777", issueNumber: 777, domainId: 2 });
    const { deps, rows } = makeDeps2(item);

    await cmdTrack(["777", "-d", "otherdom", "--scrutiny", "high"], deps);

    // The reader that matters is a phase script standing in the target domain.
    expect([...rows.keys()]).toEqual([`${normalizeStateRoot(otherDir)} workitem:d2:#777 scrutiny`]);
    expect([...rows.values()]).toEqual(["high"]);
    // And nothing at all landed under the caller's checkout.
    for (const k of rows.keys()) expect(k.startsWith(normalizeStateRoot(callerDir))).toBe(false);
  });

  test("track -d validates --meta against the TARGET domain's manifest", async () => {
    const item = makeWorkItem({ id: "d2:#777", issueNumber: 777, domainId: 2 });
    const { deps } = makeDeps2(item);
    // `scrutiny` is declared only in otherDir's manifest; the caller's dir has none at all.
    // A caller-rooted read would either accept anything (no fields declared → no checking)
    // or call the flag unknown. Rejecting `bogus` by the enum's own value list is what only
    // the target's manifest can do.
    const err = await cmdTrack(["777", "-d", "otherdom", "--scrutiny", "bogus"], deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExitError);
  });

  test("track -d sends the target domain's root as repoRoot, so the daemon validates the right manifest", async () => {
    const item = makeWorkItem({ id: "d2:#777", issueNumber: 777, domainId: 2 });
    const { deps, seen } = makeDeps2(item);

    await cmdTrack(["777", "-d", "otherdom"], deps);

    const track = seen.find((s) => s.method === "trackWorkItem");
    expect(track?.params.repoRoot).toBe(otherDir);
    expect(track?.params.domain).toBe("otherdom");
    // `initial: plan` comes from the target's manifest, not from a caller with none.
    expect(track?.params.initialPhase).toBe("plan");
  });

  test("untrack -d deletes the namespace in the target domain, not the caller's", async () => {
    const item = makeWorkItem({ id: "d2:#777", issueNumber: 777, domainId: 2 });
    const { deps, rows } = makeDeps2(item, [
      [otherDir, "workitem:d2:#777", "scrutiny", "high"],
      [callerDir, "workitem:d2:#777", "scrutiny", "decoy"],
    ]);

    await cmdUntrack(["777", "-d", "otherdom"], deps);

    expect(rows.has(`${normalizeStateRoot(otherDir)} workitem:d2:#777 scrutiny`)).toBe(false);
    // The caller's own partition is untouched — untrack is not a cross-domain delete.
    expect(rows.get(`${normalizeStateRoot(callerDir)} workitem:d2:#777 scrutiny`)).toBe("decoy");
  });

  test("tracked -d --json reads state from the target domain's root", async () => {
    const item = makeWorkItem({ id: "d2:#777", issueNumber: 777, domainId: 2 });
    const { deps } = makeDeps2(item, [[otherDir, "workitem:d2:#777", "scrutiny", "high"]]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await cmdTracked(["--json", "-d", "otherdom"], deps);
    } finally {
      console.log = origLog;
    }

    expect(JSON.parse(logs.join(""))[0].state).toEqual({ scrutiny: "high" });
  });

  // `_` is a partition, not a checkout: there is no manifest to read and no root to key
  // state under, so the command behaves exactly as it does from a directory with neither.
  test("track -d _ writes no metadata and sends no repoRoot", async () => {
    const item = makeWorkItem({ id: "#777", issueNumber: 777, domainId: 0 });
    const { deps, rows, seen } = makeDeps2(item);

    await cmdTrack(["777", "-d", "_"], deps);

    expect([...rows.keys()]).toEqual([]);
    const track = seen.find((s) => s.method === "trackWorkItem");
    expect(track?.params.repoRoot).toBeUndefined();
    expect(track?.params.domain).toBe("_");
    // No domain lookup either — `_` resolves without a row, on both sides of the wire.
    expect(seen.map((s) => s.method)).not.toContain("domainShow");
  });

  test("without -d nothing changes: the caller's own root is still the state root", async () => {
    writeFileSync(join(callerDir, ".mcx.yaml"), OTHER_MANIFEST);
    clearFindGitRootCache();
    const item = makeWorkItem({ id: "#777", issueNumber: 777, domainId: 0 });
    const { deps, rows, seen } = makeDeps2(item);

    await cmdTrack(["777", "--scrutiny", "low"], deps);

    expect([...rows.keys()]).toEqual([`${normalizeStateRoot(callerDir)} workitem:#777 scrutiny`]);
    expect(seen.map((s) => s.method)).not.toContain("domainShow");
  });
});
