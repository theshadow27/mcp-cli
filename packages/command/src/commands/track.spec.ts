import { describe, expect, test } from "bun:test";
import type { IpcMethod, IpcMethodResult, Manifest, TrackableField, WorkItem } from "@mcp-cli/core";
import { loadManifest } from "@mcp-cli/core";
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
    expect(captured).toEqual({ number: 1135, repoRoot: expect.any(String) });
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
    expect(captured).toEqual({ branch: "feat/test", repoRoot: expect.any(String) });
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

  test("untracks branch:NAME format emitted by mcx tracked --json", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["branch:feat/test"], deps);
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

  test("untracks #NNNN format", async () => {
    let captured: unknown;
    const deps = makeDeps({
      untrackWorkItem: (params: unknown) => {
        captured = params;
        return { ok: true, deleted: true };
      },
    });

    await cmdUntrack(["#1135"], deps);
    expect(captured).toEqual({ number: 1135 });
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
    expect(captured).toEqual({ number: 1186 });
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
      expect(captured).toEqual({ number: 1135, initialPhase: "plan", repoRoot: expect.any(String) });
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

    test("cmdTrack persists default value when field not provided", async () => {
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
              if (method === "listWorkItems") return items as IpcMethodResult[M];
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
