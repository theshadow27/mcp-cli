import { describe, expect, test } from "bun:test";
import type { WorkItem } from "@mcp-cli/core";
import {
  type TranscriptEntry,
  compactTranscript,
  estimateCost,
  filterByRepo,
  formatAge,
  formatCost,
  formatElapsed,
  formatLifecycleLine,
  formatSessionShort,
  walkTranscript,
} from "./session-display";

describe("estimateCost", () => {
  test("returns null for zero tokens", () => {
    expect(estimateCost(0)).toBeNull();
  });

  test("returns null for undefined/null", () => {
    expect(estimateCost(undefined)).toBeNull();
    expect(estimateCost(null)).toBeNull();
  });

  test("estimates cost at $5/M tokens", () => {
    const cost = estimateCost(1_000_000);
    expect(cost).toBeCloseTo(5.0, 4);
  });

  test("estimates small token counts", () => {
    const cost = estimateCost(1000);
    expect(cost).toBeCloseTo(0.005, 6);
  });
});

describe("formatCost", () => {
  test("uses real cost when available", () => {
    expect(formatCost(1.2345, 1000)).toBe("$1.2345");
  });

  test("uses estimated cost when real cost is null", () => {
    expect(formatCost(null, 1000)).toBe("~$0.0050");
  });

  test("uses estimated cost when real cost is zero", () => {
    expect(formatCost(0, 1000)).toBe("~$0.0050");
  });

  test("returns dash when no cost or tokens", () => {
    expect(formatCost(null, null)).toBe("—");
    expect(formatCost(null, 0)).toBe("—");
  });
});

describe("filterByRepo", () => {
  const sessions = [
    { sessionId: "a", cwd: "/repo/project/src" },
    { sessionId: "b", cwd: "/other/place" },
    { sessionId: "c", cwd: "/repo/project/tests" },
    { sessionId: "d", cwd: null },
  ];

  test("filters sessions by repo root prefix", () => {
    const filtered = filterByRepo(sessions, "/repo/project");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.sessionId)).toEqual(["a", "c"]);
  });

  test("excludes sessions with null cwd", () => {
    const filtered = filterByRepo(sessions, "/repo/project");
    expect(filtered.every((s) => s.cwd !== null)).toBe(true);
  });

  test("returns empty when no matches", () => {
    const filtered = filterByRepo(sessions, "/nonexistent");
    expect(filtered).toHaveLength(0);
  });
});

describe("compactTranscript", () => {
  test("truncates long tool results", () => {
    const longResult = "x".repeat(200);
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "result", result: longResult },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    const result = (compacted[0].message as Record<string, unknown>).result as string;
    expect(result.length).toBe(101); // 100 chars + "…"
    expect(result.endsWith("…")).toBe(true);
  });

  test("leaves short results unchanged", () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "result", result: "short" },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    expect((compacted[0].message as Record<string, unknown>).result).toBe("short");
  });

  test("truncates tool_result content in assistant messages", () => {
    const longContent = "y".repeat(200);
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: {
          type: "assistant",
          message: {
            content: [{ type: "tool_result", content: longContent }],
          },
        },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    const msg = compacted[0].message.message as { content: Array<{ content: string }> };
    expect(msg.content[0].content.length).toBe(101);
    expect(msg.content[0].content.endsWith("…")).toBe(true);
  });

  test("preserves non-tool entries unchanged", () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: { type: "user", message: { content: "hello" } },
      },
    ];
    const compacted = compactTranscript(entries, 100);
    expect(compacted).toEqual(entries);
  });
});

describe("formatAge", () => {
  const NOW = Date.UTC(2026, 2, 23, 12, 0, 0); // 2026-03-23 12:00 UTC

  test("returns empty string for null/undefined", () => {
    expect(formatAge(null, NOW)).toBe("");
    expect(formatAge(undefined, NOW)).toBe("");
  });

  test("returns empty string for sessions < 24h old", () => {
    const recent = NOW - 23 * 60 * 60 * 1000; // 23 hours ago
    expect(formatAge(recent, NOW)).toBe("");
  });

  test("returns date label for sessions >= 24h old", () => {
    const old = Date.UTC(2026, 2, 19, 10, 0, 0); // Mar 19
    expect(formatAge(old, NOW)).toBe("(Mar 19)");
  });

  test("returns date label for sessions days old", () => {
    const old = Date.UTC(2026, 0, 15, 8, 0, 0); // Jan 15
    expect(formatAge(old, NOW)).toBe("(Jan 15)");
  });
});

describe("formatSessionShort with createdAt", () => {
  test("appends age for old sessions", () => {
    const old = Date.UTC(2026, 2, 19, 10, 0, 0);
    const line = formatSessionShort({
      sessionId: "e94a6668-1234-5678-9abc-def012345678",
      state: "active",
      model: "claude-opus-4-6[1m]",
      cost: 519.51,
      tokens: 4912380,
      numTurns: 8415,
      createdAt: old,
    });
    expect(line).toContain("(Mar 19)");
    expect(line).toStartWith("e94a6668");
  });

  test("no age suffix for recent sessions", () => {
    const line = formatSessionShort({
      sessionId: "84418297-1234-5678-9abc-def012345678",
      state: "active",
      model: "claude-opus-4-6[1m]",
      cost: 1.01,
      tokens: 6885,
      numTurns: 27,
      createdAt: Date.now(),
    });
    expect(line).not.toContain("(");
  });

  test("no age suffix when createdAt is null", () => {
    const line = formatSessionShort({
      sessionId: "84418297-1234-5678-9abc-def012345678",
      state: "active",
      createdAt: null,
    });
    expect(line).not.toContain("(");
  });

  test("shows [RATE LIMITED] when rateLimited is true", () => {
    const line = formatSessionShort({
      sessionId: "84418297-1234-5678-9abc-def012345678",
      state: "active",
      rateLimited: true,
    });
    expect(line).toContain("[RATE LIMITED]");
  });

  test("does not show [RATE LIMITED] when rateLimited is false", () => {
    const line = formatSessionShort({
      sessionId: "84418297-1234-5678-9abc-def012345678",
      state: "active",
      rateLimited: false,
    });
    expect(line).not.toContain("[RATE LIMITED]");
  });
});

// Strip ANSI escape codes for test assertions
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "#1135",
    issueNumber: 1135,
    branch: "feat/issue-1135-test",
    prNumber: null,
    prState: null,
    prUrl: null,
    ciStatus: "none",
    ciRunId: null,
    ciSummary: null,
    reviewStatus: "none",
    mergeStateStatus: null,
    phase: "impl",
    createdAt: "2026-04-10T00:00:00Z",
    updatedAt: "2026-04-10T00:00:00Z",
    version: 1,
    ...overrides,
  };
}

describe("formatElapsed", () => {
  test("formats seconds as MM:SS", () => {
    expect(formatElapsed(90_000)).toBe("1:30");
    expect(formatElapsed(5_000)).toBe("0:05");
  });

  test("formats hours as HH:MM:SS", () => {
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });
});

describe("walkTranscript", () => {
  function makeUserMsg(text: string): TranscriptEntry {
    return {
      timestamp: Date.now(),
      direction: "outbound",
      message: {
        type: "user",
        message: { content: [{ type: "text", text }] },
      },
    };
  }

  function makeAssistantMsg(content: unknown[]): TranscriptEntry {
    return {
      timestamp: Date.now(),
      direction: "inbound",
      message: { type: "assistant", message: { content } },
    };
  }

  function makeToolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
    return { type: "tool_use", id: "tu1", name, input };
  }

  test("extracts last user prompt", () => {
    const entries = [makeUserMsg("first"), makeUserMsg("second")];
    const stats = walkTranscript(entries);
    expect(stats.lastPrompt).toBe("second");
  });

  test("skips prompts with only tool_result blocks", () => {
    const entries: TranscriptEntry[] = [
      makeUserMsg("the real prompt"),
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "x", content: "some output" }] },
        },
      },
    ];
    const stats = walkTranscript(entries);
    expect(stats.lastPrompt).toBe("the real prompt");
  });

  test("extracts last assistant text as lastResult", () => {
    const entries = [
      makeAssistantMsg([{ type: "text", text: "first response" }]),
      makeAssistantMsg([{ type: "text", text: "second response" }]),
    ];
    const stats = walkTranscript(entries);
    expect(stats.lastResult).toBe("second response");
  });

  test("extracts lastResult from result type message", () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "result", result: "Done! All tests pass." },
      },
    ];
    const stats = walkTranscript(entries);
    expect(stats.lastResult).toBe("Done! All tests pass.");
  });

  test("aggregates Read line counts into directory footprint", () => {
    const entries = [
      makeAssistantMsg([makeToolUse("Read", { file_path: "/src/foo.ts", limit: 100 })]),
      makeAssistantMsg([makeToolUse("Read", { file_path: "/src/bar.ts", limit: 50 })]),
      makeAssistantMsg([makeToolUse("Read", { file_path: "/lib/baz.ts", limit: 200 })]),
    ];
    const stats = walkTranscript(entries);
    const src = stats.directoryFootprint.find((e) => e.dir === "/src");
    expect(src?.reads).toBe(150); // 100 + 50
    expect(src?.writes).toBe(0);
    const lib = stats.directoryFootprint.find((e) => e.dir === "/lib");
    expect(lib?.reads).toBe(200);
  });

  test("Read without limit defaults to 2000 lines", () => {
    const entries = [makeAssistantMsg([makeToolUse("Read", { file_path: "/src/foo.ts" })])];
    const stats = walkTranscript(entries);
    const src = stats.directoryFootprint.find((e) => e.dir === "/src");
    expect(src?.reads).toBe(2000);
  });

  test("aggregates Write byte count and Edit line count into directory footprint writes", () => {
    const entries = [
      makeAssistantMsg([makeToolUse("Write", { file_path: "/src/foo.ts", content: "hello world" })]), // 11 bytes
      makeAssistantMsg([makeToolUse("Edit", { file_path: "/src/bar.ts", old_string: "a", new_string: "x\ny\nz" })]), // 3 lines
    ];
    const stats = walkTranscript(entries);
    const src = stats.directoryFootprint.find((e) => e.dir === "/src");
    expect(src?.writes).toBe(14); // 11 bytes + 3 lines
    expect(src?.reads).toBe(0);
  });

  test("Write uses UTF-8 byte count not JS string length for non-ASCII content", () => {
    // "café" is 4 JS chars but 5 UTF-8 bytes (é = 2 bytes)
    const entries = [makeAssistantMsg([makeToolUse("Write", { file_path: "/src/foo.ts", content: "café" })])];
    const stats = walkTranscript(entries);
    const src = stats.directoryFootprint.find((e) => e.dir === "/src");
    expect(src?.writes).toBe(5);
  });

  test("MultiEdit accumulates line counts from edits array", () => {
    const entries = [
      makeAssistantMsg([
        makeToolUse("MultiEdit", {
          file_path: "/src/foo.ts",
          edits: [
            { old_string: "a", new_string: "x\ny\nz" }, // 3 lines
            { old_string: "b", new_string: "p\nq" }, // 2 lines
          ],
        }),
      ]),
    ];
    const stats = walkTranscript(entries);
    const src = stats.directoryFootprint.find((e) => e.dir === "/src");
    expect(src?.writes).toBe(5); // 3 + 2, not 1
  });

  test("MultiEdit with empty edits array contributes 0 to footprint", () => {
    const entries = [makeAssistantMsg([makeToolUse("MultiEdit", { file_path: "/src/foo.ts", edits: [] })])];
    const stats = walkTranscript(entries);
    const src = stats.directoryFootprint.find((e) => e.dir === "/src");
    expect(src?.writes).toBe(0);
  });

  test("aggregates Bash commands by first token", () => {
    const entries = [
      makeAssistantMsg([makeToolUse("Bash", { command: "bun test foo.spec.ts" })]),
      makeAssistantMsg([makeToolUse("Bash", { command: "bun test bar.spec.ts" })]),
      makeAssistantMsg([makeToolUse("Bash", { command: "git status" })]),
    ];
    const stats = walkTranscript(entries);
    const bun = stats.commandSummary.find((e) => e.cmd === "bun");
    expect(bun?.count).toBe(2);
    const git = stats.commandSummary.find((e) => e.cmd === "git");
    expect(git?.count).toBe(1);
  });

  test("collects last N Grep/Glob queries", () => {
    const entries = [
      makeAssistantMsg([makeToolUse("Grep", { pattern: "foo", path: "/src" })]),
      makeAssistantMsg([makeToolUse("Glob", { pattern: "**/*.ts" })]),
      makeAssistantMsg([makeToolUse("Grep", { pattern: "bar" })]),
      makeAssistantMsg([makeToolUse("Grep", { pattern: "baz" })]),
    ];
    const stats = walkTranscript(entries, 3);
    expect(stats.lastQueries).toHaveLength(3);
    expect(stats.lastQueries[0].pattern).toBe("**/*.ts");
    expect(stats.lastQueries[1].pattern).toBe("bar");
    expect(stats.lastQueries[2].pattern).toBe("baz");
  });

  test("sorts footprint by total activity descending", () => {
    const entries = [
      makeAssistantMsg([makeToolUse("Read", { file_path: "/a/f.ts", limit: 10 })]),
      makeAssistantMsg([makeToolUse("Read", { file_path: "/b/f.ts", limit: 10 })]),
      makeAssistantMsg([makeToolUse("Read", { file_path: "/b/g.ts", limit: 10 })]),
      makeAssistantMsg([makeToolUse("Write", { file_path: "/b/h.ts", content: "hello" })]),
    ];
    const stats = walkTranscript(entries);
    expect(stats.directoryFootprint[0].dir).toBe("/b");
    expect(stats.directoryFootprint[0].reads).toBe(20); // 2 × 10
    expect(stats.directoryFootprint[0].writes).toBe(5); // "hello".length
  });

  test("returns empty stats for empty transcript", () => {
    const stats = walkTranscript([]);
    expect(stats.lastPrompt).toBeNull();
    expect(stats.lastResult).toBeNull();
    expect(stats.directoryFootprint).toHaveLength(0);
    expect(stats.commandSummary).toHaveLength(0);
    expect(stats.lastQueries).toHaveLength(0);
  });

  test("attributes Bash lastOutput by tool_use_id, not first-null heuristic", () => {
    // Interleaved: bun → result, Read → result, git → result
    // Verify bun gets its own output and git gets its own output (not crossed)
    const entries: TranscriptEntry[] = [
      makeAssistantMsg([{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "bun test foo.spec.ts" } }]),
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "PASS 10 tests" }] },
        },
      },
      makeAssistantMsg([{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/src/foo.ts" } }]),
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }] },
        },
      },
      makeAssistantMsg([{ type: "tool_use", id: "bash-2", name: "Bash", input: { command: "git status" } }]),
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "bash-2", content: "On branch main" }] },
        },
      },
    ];
    const stats = walkTranscript(entries);
    const bun = stats.commandSummary.find((e) => e.cmd === "bun");
    const git = stats.commandSummary.find((e) => e.cmd === "git");
    expect(bun?.lastOutput).toBe("PASS 10 tests");
    expect(git?.lastOutput).toBe("On branch main");
    // Non-Bash tool_result must not bleed into any Bash command
    expect(bun?.lastOutput).not.toContain("file contents");
    expect(git?.lastOutput).not.toContain("file contents");
  });

  test("later Bash result overwrites lastOutput for same command key", () => {
    const entries: TranscriptEntry[] = [
      makeAssistantMsg([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test" } }]),
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "FAIL" }] } },
      },
      makeAssistantMsg([{ type: "tool_use", id: "b2", name: "Bash", input: { command: "bun test" } }]),
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b2", content: "PASS" }] } },
      },
    ];
    const stats = walkTranscript(entries);
    const bun = stats.commandSummary.find((e) => e.cmd === "bun");
    expect(bun?.count).toBe(2);
    expect(bun?.lastOutput).toBe("PASS");
  });

  test("empty Bash command string falls back to 'bash' key", () => {
    const entries: TranscriptEntry[] = [
      makeAssistantMsg([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "" } }]),
      makeAssistantMsg([{ type: "tool_use", id: "b2", name: "Bash", input: { command: "   " } }]),
    ];
    const stats = walkTranscript(entries);
    const bash = stats.commandSummary.find((e) => e.cmd === "bash");
    expect(bash).toBeDefined();
    expect(bash?.count).toBe(2);
  });

  test("lastQueryCount=0 returns empty lastQueries", () => {
    const entries: TranscriptEntry[] = [
      makeAssistantMsg([{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo" } }]),
      makeAssistantMsg([{ type: "tool_use", id: "g2", name: "Glob", input: { pattern: "*.ts" } }]),
    ];
    const stats = walkTranscript(entries, 0);
    expect(stats.lastQueries).toHaveLength(0);
  });
});

describe("formatLifecycleLine", () => {
  test("impl phase with no PR", () => {
    const line = stripAnsi(formatLifecycleLine(makeWorkItem()));
    expect(line).toBe("impl → (no PR yet)");
  });

  test("open PR with CI passed and review approved", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          prNumber: 1135,
          prState: "open",
          ciStatus: "passed",
          reviewStatus: "approved",
        }),
      ),
    );
    expect(line).toBe("impl → PR #1135 open → CI ✓ → review ✓");
  });

  test("open PR with CI failed", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          prNumber: 1135,
          prState: "open",
          ciStatus: "failed",
        }),
      ),
    );
    expect(line).toBe("impl → PR #1135 open → CI ✗");
  });

  test("open PR with CI running and review pending", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          prNumber: 1135,
          prState: "open",
          ciStatus: "running",
          reviewStatus: "pending",
        }),
      ),
    );
    expect(line).toBe("impl → PR #1135 open → CI running → review pending");
  });

  test("merged PR shows merged checkmark", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          prNumber: 1134,
          prState: "merged",
          phase: "done",
          ciStatus: "passed",
          reviewStatus: "approved",
        }),
      ),
    );
    expect(line).toBe("done → PR #1134 merged ✓");
  });

  test("closed PR shows closed", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          prNumber: 1136,
          prState: "closed",
        }),
      ),
    );
    expect(line).toBe("impl → PR #1136 closed");
  });

  test("draft PR state", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          prNumber: 1137,
          prState: "draft",
          ciStatus: "none",
        }),
      ),
    );
    expect(line).toBe("impl → PR #1137 draft");
  });

  test("review phase with changes requested", () => {
    const line = stripAnsi(
      formatLifecycleLine(
        makeWorkItem({
          phase: "review",
          prNumber: 1138,
          prState: "open",
          ciStatus: "passed",
          reviewStatus: "changes_requested",
        }),
      ),
    );
    expect(line).toBe("review → PR #1138 open → CI ✓ → review changes requested");
  });
});
