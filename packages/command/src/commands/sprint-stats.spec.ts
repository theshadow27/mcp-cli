import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "@mcp-cli/core";
import {
  aggregateSession,
  cmdSprintStats,
  filterEntriesToWindow,
  parseSprintPlan,
  projectSlug,
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

const REPO_ROOT = "/Users/foo/project";
const PROJECT_SLUG = "-Users-foo-project";

function makeProjectDir(tmpHome: string): string {
  const projDir = join(tmpHome, ".claude", "projects", PROJECT_SLUG);
  mkdirSync(projDir, { recursive: true });
  return projDir;
}

function makeDeps(
  tmpHome: string,
  overrides?: {
    workItems?: object[];
    sprintPlan?: string | null;
    gitTimestamp?: number | null;
    nowMs?: number;
    repoRoot?: string;
    worktrees?: string[];
  },
) {
  return {
    homeDir: () => tmpHome,
    listWorkItems: async () => (overrides?.workItems as WorkItem[] | undefined) ?? [],
    repoRoot: () => overrides?.repoRoot ?? REPO_ROOT,
    now: () => overrides?.nowMs ?? new Date("2026-05-20T10:00:00Z").getTime(),
    readSprintPlan: (_n: number) => overrides?.sprintPlan ?? null,
    resolveGitTimestamp: (_ref: string) => overrides?.gitTimestamp ?? null,
    discoverWorktrees: () => overrides?.worktrees ?? [],
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

// ── projectSlug ───────────────────────────────────────────────────────────

describe("projectSlug", () => {
  test("encodes cwd path to dash-separated slug", () => {
    expect(projectSlug("/Users/foo/project")).toBe("-Users-foo-project");
  });

  test("handles root path", () => {
    expect(projectSlug("/")).toBe("-");
  });
});

// ── parseSprintPlan ────────────────────────────────────────────────────────

describe("parseSprintPlan", () => {
  const NOW = new Date("2026-05-20T10:00:00Z").getTime();

  test("parses started and ended dates", () => {
    const content = `# Sprint 58

> Planned 2026-05-19 23:20 EST. Started 2026-05-19 23:35 EST. Ended 2026-05-20 01:22 EST. Target: 15 issues.`;
    const result = parseSprintPlan(content, NOW);
    expect(result).not.toBeNull();
    expect(result?.start).toBe(new Date("2026-05-20T04:35:00Z").getTime());
    expect(result?.end).toBe(new Date("2026-05-20T06:22:00Z").getTime());
    expect(result?.warnings).toEqual([]);
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

  test("emits warning for unrecognized timezone", () => {
    const content = "> Started 2026-05-19 23:35 CEST.";
    const result = parseSprintPlan(content, NOW);
    expect(result).not.toBeNull();
    expect(result?.warnings).toEqual(["unrecognized timezone 'CEST', defaulting to UTC"]);
  });
});

// ── scanSessionFiles ───────────────────────────────────────────────────────

describe("scanSessionFiles", () => {
  test("finds jsonl files in project directory", () => {
    const projDir = makeTmpDir();
    writeFileSync(join(projDir, "session-1.jsonl"), "");
    writeFileSync(join(projDir, "session-2.jsonl"), "");
    writeFileSync(join(projDir, "not-a-session.txt"), "");

    const files = scanSessionFiles(projDir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  test("returns empty array for missing directory", () => {
    expect(scanSessionFiles("/nonexistent/path")).toEqual([]);
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
    const entries = [makeAssistantEntry({ model: "claude-opus-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000 })];
    const result = aggregateSession(entries);
    const totals = result?.models.get("claude-opus-4-6");
    expect(totals?.estimatedCostUsd).toBeCloseTo(30, 1);
    expect(totals?.ratesSource).toBe("matched");
  });

  test("haiku uses lower cost rates", () => {
    const entries = [
      makeAssistantEntry({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ];
    const result = aggregateSession(entries);
    const totals = result?.models.get("claude-haiku-4-5");
    expect(totals?.estimatedCostUsd).toBeCloseTo(4.8, 1);
    expect(totals?.ratesSource).toBe("matched");
  });

  test("unknown model uses fallback rates", () => {
    const entries = [makeAssistantEntry({ model: "gpt-5-turbo", inputTokens: 1_000_000, outputTokens: 1_000_000 })];
    const result = aggregateSession(entries);
    const totals = result?.models.get("gpt-5-turbo");
    expect(totals?.estimatedCostUsd).toBeCloseTo(10, 1);
    expect(totals?.ratesSource).toBe("fallback");
  });

  test("deduplicates streaming snapshots by message.id", () => {
    const entries = [
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-03-23T10:00:00.000Z",
        message: { id: "msg-1", model: "claude-opus-4-6", usage: { input_tokens: 500, output_tokens: 100 } },
      },
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-03-23T10:00:01.000Z",
        message: { id: "msg-1", model: "claude-opus-4-6", usage: { input_tokens: 1000, output_tokens: 200 } },
      },
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-03-23T10:01:00.000Z",
        message: { id: "msg-2", model: "claude-opus-4-6", usage: { input_tokens: 300, output_tokens: 50 } },
      },
    ];
    const result = aggregateSession(entries);
    const totals = result?.models.get("claude-opus-4-6");
    expect(totals?.inputTokens).toBe(1300);
    expect(totals?.outputTokens).toBe(250);
  });
});

// ── cmdSprintStats ─────────────────────────────────────────────────────────

describe("cmdSprintStats", () => {
  test("outputs JSON with sessions:0 when no files found", async () => {
    const tmpHome = makeTmpDir();
    makeProjectDir(tmpHome);
    const { stdout } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome)));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(0);
    expect(parsed.window).toBeNull();
    expect(parsed.totals).toBeDefined();
    expect(parsed.project).toBe(PROJECT_SLUG);
  });

  test("outputs session counts and token aggregates", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "session-a.jsonl", [
      makeAssistantEntry({ sessionId: "aaa", inputTokens: 1000, outputTokens: 200 }),
    ]);
    writeJsonl(projDir, "session-b.jsonl", [
      makeAssistantEntry({ sessionId: "bbb", inputTokens: 2000, outputTokens: 400 }),
    ]);

    const { stdout } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome)));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(2);
    expect(parsed.totals.inputTokens).toBe(3000);
    expect(parsed.totals.outputTokens).toBe(600);
    expect(parsed.totals.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("only scans current repo project dir, not all projects", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "mine.jsonl", [makeAssistantEntry({ sessionId: "mine", inputTokens: 100 })]);

    // Create a different project dir that should NOT be scanned
    const otherDir = join(tmpHome, ".claude", "projects", "-Users-other-repo");
    mkdirSync(otherDir, { recursive: true });
    writeJsonl(otherDir, "theirs.jsonl", [makeAssistantEntry({ sessionId: "theirs", inputTokens: 9999 })]);

    const { stdout } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome)));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.totals.inputTokens).toBe(100);
  });

  test("--project overrides auto-detected project slug", async () => {
    const tmpHome = makeTmpDir();
    const otherSlug = "-Users-other-repo";
    const otherDir = join(tmpHome, ".claude", "projects", otherSlug);
    mkdirSync(otherDir, { recursive: true });
    writeJsonl(otherDir, "sess.jsonl", [makeAssistantEntry({ sessionId: "o1", inputTokens: 777 })]);

    const { stdout } = await captureOutput(() => cmdSprintStats(["--project", otherSlug], makeDeps(tmpHome)));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.totals.inputTokens).toBe(777);
    expect(parsed.project).toBe(otherSlug);
  });

  test("--sprint filters sessions to sprint window", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);

    writeJsonl(projDir, "inside.jsonl", [
      makeAssistantEntry({ sessionId: "in1", timestamp: "2026-05-20T00:00:00.000Z", inputTokens: 500 }),
    ]);
    writeJsonl(projDir, "outside.jsonl", [
      makeAssistantEntry({ sessionId: "out1", timestamp: "2026-05-18T00:00:00.000Z", inputTokens: 999 }),
    ]);

    const sprintPlan = "# Sprint 42\n> Started 2026-05-19 23:00 UTC. Ended 2026-05-20 12:00 UTC.";
    const { stdout } = await captureOutput(() => cmdSprintStats(["--sprint", "42"], makeDeps(tmpHome, { sprintPlan })));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.window?.label).toBe("sprint-42");
    expect(parsed.totals.inputTokens).toBe(500);
  });

  test("--since filters sessions from git timestamp", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    const cutoff = new Date("2026-05-19T10:00:00Z").getTime();

    writeJsonl(projDir, "new.jsonl", [
      makeAssistantEntry({ sessionId: "n1", timestamp: "2026-05-20T00:00:00.000Z", inputTokens: 300 }),
    ]);
    writeJsonl(projDir, "old.jsonl", [
      makeAssistantEntry({ sessionId: "o1", timestamp: "2026-05-18T00:00:00.000Z", inputTokens: 888 }),
    ]);

    const { stdout } = await captureOutput(() =>
      cmdSprintStats(["--since", "v1.0.0"], makeDeps(tmpHome, { gitTimestamp: cutoff })),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.window?.label).toBe("since:v1.0.0");
    expect(parsed.totals.inputTokens).toBe(300);
  });

  test("includes phases when work items are available", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);

    writeJsonl(projDir, "impl-session.jsonl", [
      makeAssistantEntry({ sessionId: "impl1", gitBranch: "feat/issue-99", inputTokens: 400 }),
    ]);

    const workItems: WorkItem[] = [
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
    ];

    const { stdout } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome, { workItems })));
    const parsed = JSON.parse(stdout);
    expect(parsed.phases).toBeDefined();
    expect(parsed.phases.impl).toBeDefined();
    expect(parsed.phases.impl.inputTokens).toBe(400);
  });

  test("missing --sprint argument exits with error", async () => {
    const tmpHome = makeTmpDir();
    const { stderr, exitCode } = await captureOutput(() => cmdSprintStats(["--sprint"], makeDeps(tmpHome)));
    expect(stderr).toContain("--sprint requires a sprint number");
    expect(exitCode).toBe(1);
  });

  test("missing --since argument exits with error", async () => {
    const tmpHome = makeTmpDir();
    const { stderr, exitCode } = await captureOutput(() => cmdSprintStats(["--since"], makeDeps(tmpHome)));
    expect(stderr).toContain("--since requires a tag or SHA");
    expect(exitCode).toBe(1);
  });

  test("--sprint and --since together exits with error", async () => {
    const tmpHome = makeTmpDir();
    const { stderr, exitCode } = await captureOutput(() =>
      cmdSprintStats(["--sprint", "42", "--since", "v1.0.0"], makeDeps(tmpHome)),
    );
    expect(stderr).toContain("--sprint and --since are mutually exclusive");
    expect(exitCode).toBe(1);
  });

  test("unknown flag exits with error", async () => {
    const tmpHome = makeTmpDir();
    const { stderr, exitCode } = await captureOutput(() => cmdSprintStats(["--spint", "42"], makeDeps(tmpHome)));
    expect(stderr).toContain("unknown flag '--spint'");
    expect(exitCode).toBe(1);
  });

  test("gracefully handles daemon unavailable for work items", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "sess.jsonl", [makeAssistantEntry({ sessionId: "s1", inputTokens: 100 })]);

    const deps = {
      ...makeDeps(tmpHome),
      listWorkItems: async () => {
        throw new Error("daemon not running");
      },
    };

    const { stdout } = await captureOutput(() => cmdSprintStats([], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(1);
    expect(parsed.phases).toBeUndefined();
  });

  test("emits warning for unknown TZ in sprint plan", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "sess.jsonl", [makeAssistantEntry({ sessionId: "s1", timestamp: "2026-05-20T00:00:00.000Z" })]);

    const sprintPlan = "> Started 2026-05-19 23:35 CEST. Ended 2026-05-20 12:00 UTC.";
    const { stdout, stderr } = await captureOutput(() =>
      cmdSprintStats(["--sprint", "1"], makeDeps(tmpHome, { sprintPlan })),
    );
    expect(stderr).toContain("unrecognized timezone 'CEST'");
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBeGreaterThanOrEqual(0);
  });

  test("emits warning and ratesSource for unknown model fallback", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "sess.jsonl", [
      makeAssistantEntry({ sessionId: "s1", model: "future-model-9000", inputTokens: 500 }),
    ]);

    const { stdout, stderr } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome)));
    expect(stderr).toContain("unknown model 'future-model-9000'");
    const parsed = JSON.parse(stdout);
    expect(parsed.models["future-model-9000"].ratesSource).toBe("fallback");
  });

  test("ratesSource is 'matched' for known models", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "sess.jsonl", [
      makeAssistantEntry({ sessionId: "s1", model: "claude-opus-4-6", inputTokens: 500 }),
    ]);

    const { stdout } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome)));
    const parsed = JSON.parse(stdout);
    expect(parsed.models["claude-opus-4-6"].ratesSource).toBe("matched");
  });

  test("missing --project value exits with error", async () => {
    const tmpHome = makeTmpDir();
    const { stderr, exitCode } = await captureOutput(() => cmdSprintStats(["--project"], makeDeps(tmpHome)));
    expect(stderr).toContain("--project requires a project slug");
    expect(exitCode).toBe(1);
  });

  test("--help prints usage and exits cleanly", async () => {
    const tmpHome = makeTmpDir();
    const { stdout, exitCode } = await captureOutput(() => cmdSprintStats(["--help"], makeDeps(tmpHome)));
    expect(stdout).toContain("mcx sprint-stats");
    expect(stdout).toContain("--sprint");
    expect(stdout).toContain("--since");
    expect(stdout).toContain("--project");
    expect(exitCode).toBe(0);
  });

  test("-h prints usage and exits cleanly", async () => {
    const tmpHome = makeTmpDir();
    const { stdout, exitCode } = await captureOutput(() => cmdSprintStats(["-h"], makeDeps(tmpHome)));
    expect(stdout).toContain("mcx sprint-stats");
    expect(exitCode).toBe(0);
  });

  test("--sprint filters entries by timestamp, not whole sessions", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);

    writeJsonl(projDir, "straddling.jsonl", [
      makeAssistantEntry({ sessionId: "s1", timestamp: "2026-05-19T22:00:00.000Z", inputTokens: 900 }),
      makeAssistantEntry({ sessionId: "s1", timestamp: "2026-05-20T01:00:00.000Z", inputTokens: 100 }),
    ]);

    const sprintPlan = "> Started 2026-05-19 23:00 UTC. Ended 2026-05-20 12:00 UTC.";
    const { stdout } = await captureOutput(() => cmdSprintStats(["--sprint", "42"], makeDeps(tmpHome, { sprintPlan })));
    const parsed = JSON.parse(stdout);
    expect(parsed.totals.inputTokens).toBe(100);
  });

  test("phase sessions not double-counted for multi-model sessions", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);

    writeJsonl(projDir, "multi.jsonl", [
      makeAssistantEntry({ sessionId: "mm1", model: "claude-opus-4-6", gitBranch: "feat/x", inputTokens: 100 }),
      makeAssistantEntry({ sessionId: "mm1", model: "claude-sonnet-4-6", gitBranch: "feat/x", inputTokens: 200 }),
    ]);

    const workItems: WorkItem[] = [
      {
        id: "#1",
        issueNumber: 1,
        branch: "feat/x",
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
    ];

    const { stdout } = await captureOutput(() => cmdSprintStats([], makeDeps(tmpHome, { workItems })));
    const parsed = JSON.parse(stdout);
    expect(parsed.phases.impl.sessions).toBe(1);
    expect(parsed.phases.impl.inputTokens).toBe(300);
  });

  test("includes sessions from worktree project dirs", async () => {
    const tmpHome = makeTmpDir();
    const projDir = makeProjectDir(tmpHome);
    writeJsonl(projDir, "main.jsonl", [makeAssistantEntry({ sessionId: "m1", inputTokens: 100 })]);

    const wtSlug = "-Users-foo-project-.claude-worktrees-wt1";
    const wtDir = join(tmpHome, ".claude", "projects", wtSlug);
    mkdirSync(wtDir, { recursive: true });
    writeJsonl(wtDir, "wt.jsonl", [makeAssistantEntry({ sessionId: "w1", inputTokens: 200 })]);

    const deps = makeDeps(tmpHome, {
      worktrees: ["/Users/foo/project/.claude/worktrees/wt1"],
    });

    const { stdout } = await captureOutput(() => cmdSprintStats([], deps));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toBe(2);
    expect(parsed.totals.inputTokens).toBe(300);
  });
});

// ── filterEntriesToWindow ─────────────────────────────────────────────────

describe("filterEntriesToWindow", () => {
  const window = { start: 1000, end: 2000, label: "test" };

  test("keeps entries within window", () => {
    const entries = [
      { timestamp: new Date(1500).toISOString(), sessionId: "s1" },
      { timestamp: new Date(500).toISOString(), sessionId: "s1" },
      { timestamp: new Date(2500).toISOString(), sessionId: "s1" },
    ];
    const result = filterEntriesToWindow(entries, window);
    expect(result).toHaveLength(1);
  });

  test("keeps entries without timestamps", () => {
    const entries = [{ sessionId: "s1", type: "user" }];
    const result = filterEntriesToWindow(entries, window);
    expect(result).toHaveLength(1);
  });
});
