import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "@mcp-cli/core";
import {
  aggregateSession,
  cmdSprintStats,
  parseSprintPlan,
  readSessionEntries,
  scanSessionFiles,
} from "./sprint-stats";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sprint-stats-test-"));
}

function writeJsonl(dir: string, name: string, entries: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}

function makeAssistantEntry(overrides: {
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}): object {
  return {
    type: "assistant",
    sessionId: overrides.sessionId ?? "test-session-id",
    timestamp: overrides.timestamp ?? "2026-03-23T10:00:00.000Z",
    gitBranch: overrides.gitBranch ?? "main",
    message: {
      model: overrides.model ?? "claude-opus-4-6",
      usage: {
        input_tokens: overrides.inputTokens ?? 1000,
        output_tokens: overrides.outputTokens ?? 500,
        cache_creation_input_tokens: overrides.cacheCreationTokens ?? 0,
        cache_read_input_tokens: overrides.cacheReadTokens ?? 0,
      },
    },
  };
}

async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWrite = process.stderr.write.bind(process.stderr);

  console.log = (...args: unknown[]) => stdoutChunks.push(args.join(" "));
  console.error = (...args: unknown[]) => stderrChunks.push(args.join(" "));
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  const savedExitCode = process.exitCode;
  process.exitCode = 0;
  let capturedExitCode = 0;

  try {
    await fn();
  } finally {
    capturedExitCode = (process.exitCode as number) ?? 0;
    console.log = origLog;
    console.error = origError;
    process.stderr.write = origWrite;
    process.exitCode = savedExitCode;
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: capturedExitCode };
}

// ── parseSprintPlan ────────────────────────────────────────────────────────

describe("parseSprintPlan", () => {
  const NOW = new Date("2026-05-20T10:00:00Z").getTime();

  test("parses started and ended dates", () => {
    const content = `# Sprint 58

> Planned 2026-05-19 23:20 EST. Started 2026-05-19 23:35 EST. Ended 2026-05-20 01:22 EST. Target: 15 issues.`;
    const result = parseSprintPlan(content, NOW);
    expect(result).not.toBeNull();
    expect(result?.start).toBe(new Date("2026-05-20T04:35:00Z").getTime()); // 23:35 EST = 04:35 UTC+1day
    expect(result?.end).toBe(new Date("2026-05-20T06:22:00Z").getTime()); // 01:22 EST = 06:22 UTC
  });

  test("uses now as end when Ended is absent", () => {
    const content = "> Started 2026-05-19 23:35 EST. Target: 15 issues.";
    const result = parseSprintPlan(content, NOW);
    expect(result).not.toBeNull();
    expect(result?.end).toBe(NOW);
  });

  test("returns null when Started is missing", () => {
    const content = "> Planned 2026-05-19. Target: 15 issues.";
    const result = parseSprintPlan(content, NOW);
    expect(result).toBeNull();
  });

  test("handles UTC timezone", () => {
    const content = "> Started 2026-01-01 12:00 UTC.";
    const result = parseSprintPlan(content, NOW);
    expect(result).not.toBeNull();
    expect(result?.start).toBe(new Date("2026-01-01T12:00:00Z").getTime());
  });
});

// ── scanSessionFiles ───────────────────────────────────────────────────────

describe("scanSessionFiles", () => {
  test("finds jsonl files in subdirectories", () => {
    const root = makeTmpDir();
    const proj = join(root, "-Users-foo-project");
    mkdirSync(proj);
    writeFileSync(join(proj, "session-1.jsonl"), "");
    writeFileSync(join(proj, "session-2.jsonl"), "");
    writeFileSync(join(proj, "not-a-session.txt"), "");

    const files = scanSessionFiles(root);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  test("returns empty array for missing directory", () => {
    expect(scanSessionFiles("/nonexistent/path")).toEqual([]);
  });

  test("skips non-directory entries", () => {
    const root = makeTmpDir();
    writeFileSync(join(root, "stray.jsonl"), "");
    const files = scanSessionFiles(root);
    // stray.jsonl is directly in root, not in a subdirectory — scanSessionFiles
    // only looks one level deep (project subdirs)
    expect(files).toHaveLength(0);
  });
});

// ── readSessionEntries ─────────────────────────────────────────────────────

describe("readSessionEntries", () => {
  test("parses valid JSONL entries", () => {
    const dir = makeTmpDir();
    const path = writeJsonl(dir, "test.jsonl", [{ type: "user", sessionId: "abc" }, { type: "assistant" }]);
    const entries = readSessionEntries(path);
    expect(entries).toHaveLength(2);
  });

  test("skips malformed lines", () => {
    const dir = makeTmpDir();
    const path = join(dir, "bad.jsonl");
    writeFileSync(path, '{"ok":1}\nnot json\n{"also":2}\n');
    const entries = readSessionEntries(path);
    expect(entries).toHaveLength(2);
  });

  test("returns empty array for missing file", () => {
    expect(readSessionEntries("/nonexistent/file.jsonl")).toEqual([]);
  });

  test("skips blank lines", () => {
    const dir = makeTmpDir();
    const path = join(dir, "blank.jsonl");
    writeFileSync(path, '{"a":1}\n\n\n{"b":2}\n');
    const entries = readSessionEntries(path);
    expect(entries).toHaveLength(2);
  });
});

// ── aggregateSession ───────────────────────────────────────────────────────

describe("aggregateSession", () => {
  test("aggregates token counts across entries", () => {
    const entries = [
      makeAssistantEntry({ inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 500, cacheReadTokens: 300 }),
      makeAssistantEntry({
        timestamp: "2026-03-23T10:01:00.000Z",
        inputTokens: 2000,
        outputTokens: 400,
      }),
    ];
    const result = aggregateSession(entries);
    expect(result).not.toBeNull();
    const totals = result?.models.get("claude-opus-4-6");
    expect(totals?.inputTokens).toBe(3000);
    expect(totals?.outputTokens).toBe(600);
    expect(totals?.cacheCreationTokens).toBe(500);
    expect(totals?.cacheReadTokens).toBe(300);
  });

  test("captures session timing", () => {
    const entries = [
      makeAssistantEntry({ timestamp: "2026-03-23T10:00:00.000Z" }),
      makeAssistantEntry({ timestamp: "2026-03-23T11:30:00.000Z" }),
    ];
    const result = aggregateSession(entries);
    expect(result?.firstTs).toBe(new Date("2026-03-23T10:00:00.000Z").getTime());
    expect(result?.lastTs).toBe(new Date("2026-03-23T11:30:00.000Z").getTime());
  });

  test("captures branch from first gitBranch", () => {
    const entries = [makeAssistantEntry({ gitBranch: "feat/issue-123" })];
    const result = aggregateSession(entries);
    expect(result?.branch).toBe("feat/issue-123");
  });

  test("tracks multiple models separately", () => {
    const entries = [
      makeAssistantEntry({ model: "claude-opus-4-6", inputTokens: 100 }),
      makeAssistantEntry({ model: "claude-sonnet-4-6", inputTokens: 200 }),
    ];
    const result = aggregateSession(entries);
    expect(result?.models.size).toBe(2);
    expect(result?.models.get("claude-opus-4-6")?.inputTokens).toBe(100);
    expect(result?.models.get("claude-sonnet-4-6")?.inputTokens).toBe(200);
  });

  test("returns null for entries with no usage data", () => {
    const entries = [{ type: "user", sessionId: "abc", timestamp: "2026-03-23T10:00:00.000Z" }];
    const result = aggregateSession(entries);
    expect(result).toBeNull();
  });

  test("estimates cost using model rates", () => {
    // opus: input=$15/M, output=$75/M
    const entries = [makeAssistantEntry({ model: "claude-opus-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000 })];
    const result = aggregateSession(entries);
    const cost = result?.models.get("claude-opus-4-6")?.estimatedCostUsd;
    expect(cost).toBeCloseTo(90, 1); // $15 + $75 = $90
  });

  test("haiku uses lower cost rates", () => {
    const entries = [
      makeAssistantEntry({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ];
    const result = aggregateSession(entries);
    const cost = result?.models.get("claude-haiku-4-5")?.estimatedCostUsd;
    expect(cost).toBeCloseTo(4.8, 1); // $0.8 + $4 = $4.8
  });
});

// ── cmdSprintStats ─────────────────────────────────────────────────────────

describe("cmdSprintStats", () => {
  function makeDeps(overrides?: {
    projectsDir?: string;
    workItems?: object[];
    sprintPlan?: string | null;
    gitTimestamp?: number | null;
    nowMs?: number;
  }) {
    const projectsDir = overrides?.projectsDir ?? makeTmpDir();
    return {
      homeDir: () => {
        // Return a parent of projectsDir so scanSessionFiles finds it correctly
        const parent = projectsDir.replace(/\/projects$/, "");
        return parent;
      },
      listWorkItems: async () => (overrides?.workItems as WorkItem[] | undefined) ?? [],
      repoRoot: () => "/test/repo",
      now: () => overrides?.nowMs ?? new Date("2026-05-20T10:00:00Z").getTime(),
      readSprintPlan: (_n: number) => overrides?.sprintPlan ?? null,
      resolveGitTimestamp: (_ref: string) => overrides?.gitTimestamp ?? null,
    };
  }

  test("outputs JSON with sessions:0 when no files found", async () => {
    const tmpHome = makeTmpDir();
    mkdirSync(join(tmpHome, ".claude", "projects"), { recursive: true });
    const deps = {
      homeDir: () => tmpHome,
      listWorkItems: async () => [],
      repoRoot: () => "/test",
      now: () => Date.now(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => null,
    };
    const { stdout } = await captureOutput(() => cmdSprintStats([], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(0);
    expect(parsed.window).toBeNull();
    expect(parsed.totals).toBeDefined();
  });

  test("outputs session counts and token aggregates", async () => {
    const tmpHome = makeTmpDir();
    const projDir = join(tmpHome, ".claude", "projects", "-Users-foo-project");
    mkdirSync(projDir, { recursive: true });
    writeJsonl(projDir, "session-a.jsonl", [
      makeAssistantEntry({ sessionId: "aaa", inputTokens: 1000, outputTokens: 200 }),
    ]);
    writeJsonl(projDir, "session-b.jsonl", [
      makeAssistantEntry({ sessionId: "bbb", inputTokens: 2000, outputTokens: 400 }),
    ]);

    const deps = {
      homeDir: () => tmpHome,
      listWorkItems: async () => [],
      repoRoot: () => "/test",
      now: () => Date.now(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => null,
    };

    const { stdout } = await captureOutput(() => cmdSprintStats([], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(2);
    expect(parsed.totals.inputTokens).toBe(3000);
    expect(parsed.totals.outputTokens).toBe(600);
    expect(parsed.totals.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("--sprint filters sessions to sprint window", async () => {
    const tmpHome = makeTmpDir();
    const projDir = join(tmpHome, ".claude", "projects", "-Users-foo-project");
    mkdirSync(projDir, { recursive: true });

    // Session inside sprint window
    writeJsonl(projDir, "inside.jsonl", [
      makeAssistantEntry({ sessionId: "in1", timestamp: "2026-05-20T00:00:00.000Z", inputTokens: 500 }),
    ]);
    // Session outside sprint window (before)
    writeJsonl(projDir, "outside.jsonl", [
      makeAssistantEntry({ sessionId: "out1", timestamp: "2026-05-18T00:00:00.000Z", inputTokens: 999 }),
    ]);

    const sprintPlan = "# Sprint 42\n> Started 2026-05-19 23:00 UTC. Ended 2026-05-20 12:00 UTC.";
    const deps = {
      homeDir: () => tmpHome,
      listWorkItems: async () => [],
      repoRoot: () => "/test",
      now: () => new Date("2026-05-20T10:00:00Z").getTime(),
      readSprintPlan: () => sprintPlan,
      resolveGitTimestamp: () => null,
    };

    const { stdout } = await captureOutput(() => cmdSprintStats(["--sprint", "42"], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.window?.label).toBe("sprint-42");
    expect(parsed.totals.inputTokens).toBe(500);
  });

  test("--since filters sessions from git timestamp", async () => {
    const tmpHome = makeTmpDir();
    const projDir = join(tmpHome, ".claude", "projects", "-Users-foo-project");
    mkdirSync(projDir, { recursive: true });

    const cutoff = new Date("2026-05-19T10:00:00Z").getTime();

    writeJsonl(projDir, "new.jsonl", [
      makeAssistantEntry({ sessionId: "n1", timestamp: "2026-05-20T00:00:00.000Z", inputTokens: 300 }),
    ]);
    writeJsonl(projDir, "old.jsonl", [
      makeAssistantEntry({ sessionId: "o1", timestamp: "2026-05-18T00:00:00.000Z", inputTokens: 888 }),
    ]);

    const deps = {
      homeDir: () => tmpHome,
      listWorkItems: async () => [],
      repoRoot: () => "/test",
      now: () => new Date("2026-05-21T00:00:00Z").getTime(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => cutoff,
    };

    const { stdout } = await captureOutput(() => cmdSprintStats(["--since", "v1.0.0"], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.window?.label).toBe("since:v1.0.0");
    expect(parsed.totals.inputTokens).toBe(300);
  });

  test("includes phases when work items are available", async () => {
    const tmpHome = makeTmpDir();
    const projDir = join(tmpHome, ".claude", "projects", "-Users-foo-project");
    mkdirSync(projDir, { recursive: true });

    writeJsonl(projDir, "impl-session.jsonl", [
      makeAssistantEntry({ sessionId: "impl1", gitBranch: "feat/issue-99", inputTokens: 400 }),
    ]);

    const deps = {
      homeDir: () => tmpHome,
      listWorkItems: async (): Promise<WorkItem[]> => [
        {
          id: "#99",
          issueNumber: 99,
          branch: "feat/issue-99",
          phase: "impl",
          prNumber: null,
          prState: null,
          prUrl: null,
          ciStatus: "none",
          ciRunId: null,
          ciSummary: null,
          reviewStatus: "none",
          mergeStateStatus: null,
          automationOverrides: null,
          createdAt: "2026-05-19T00:00:00Z",
          updatedAt: "2026-05-19T00:00:00Z",
          version: 1,
        },
      ],
      repoRoot: () => "/test",
      now: () => Date.now(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => null,
    };

    const { stdout } = await captureOutput(() => cmdSprintStats([], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.phases).toBeDefined();
    expect(parsed.phases.impl).toBeDefined();
    expect(parsed.phases.impl.inputTokens).toBe(400);
  });

  test("missing --sprint argument exits with error", async () => {
    const deps = {
      homeDir: makeTmpDir,
      listWorkItems: async () => [],
      repoRoot: () => "/test",
      now: () => Date.now(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => null,
    };
    const { stderr, exitCode } = await captureOutput(() => cmdSprintStats(["--sprint"], deps));
    expect(stderr).toContain("--sprint requires a sprint number");
    expect(exitCode).toBe(1);
  });

  test("missing --since argument exits with error", async () => {
    const deps = {
      homeDir: makeTmpDir,
      listWorkItems: async () => [],
      repoRoot: () => "/test",
      now: () => Date.now(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => null,
    };
    const { stderr, exitCode } = await captureOutput(() => cmdSprintStats(["--since"], deps));
    expect(stderr).toContain("--since requires a tag or SHA");
    expect(exitCode).toBe(1);
  });

  test("gracefully handles daemon unavailable for work items", async () => {
    const tmpHome = makeTmpDir();
    const projDir = join(tmpHome, ".claude", "projects", "-Users-foo-project");
    mkdirSync(projDir, { recursive: true });
    writeJsonl(projDir, "sess.jsonl", [makeAssistantEntry({ sessionId: "s1", inputTokens: 100 })]);

    const deps = {
      homeDir: () => tmpHome,
      listWorkItems: async () => {
        throw new Error("daemon not running");
      },
      repoRoot: () => "/test",
      now: () => Date.now(),
      readSprintPlan: () => null,
      resolveGitTimestamp: () => null,
    };

    const { stdout } = await captureOutput(() => cmdSprintStats([], deps));
    const parsed = JSON.parse(stdout);
    // Should still return results — just without phase grouping
    expect(parsed.sessions).toBe(1);
    expect(parsed.phases).toBeUndefined();
  });
});
