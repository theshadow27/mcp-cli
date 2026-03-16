import { describe, expect, it } from "bun:test";
import {
  type TranscriptEntry,
  extractPlansFromTranscript,
  extractTodosFromTranscript,
  looksLikePlan,
  parseClaudePlanMarkdown,
  todosToPlan,
} from "./claude-plan-adapter";

// ── helpers ──

function assistantEntry(content: unknown[]): TranscriptEntry {
  return {
    timestamp: Date.now(),
    direction: "inbound",
    message: {
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", content },
    },
  };
}

function todoWriteBlock(todos: Array<{ id: string; content: string; status: string }>) {
  return { type: "tool_use", name: "TodoWrite", input: { todos } };
}

function textBlock(text: string) {
  return { type: "text", text };
}

// ── extractTodosFromTranscript ──

describe("extractTodosFromTranscript", () => {
  it("returns null when transcript has no TodoWrite calls", () => {
    const entries: TranscriptEntry[] = [assistantEntry([textBlock("Hello")])];
    expect(extractTodosFromTranscript(entries)).toBeNull();
  });

  it("extracts todos from a single TodoWrite tool_use block", () => {
    const entries = [
      assistantEntry([
        todoWriteBlock([
          { id: "1", content: "Setup project", status: "completed" },
          { id: "2", content: "Write code", status: "in_progress" },
        ]),
      ]),
    ];

    const result = extractTodosFromTranscript(entries);
    expect(result).toHaveLength(2);
    expect(result?.[0].content).toBe("Setup project");
    expect(result?.[1].status).toBe("in_progress");
  });

  it("returns the latest TodoWrite when multiple exist", () => {
    const entries = [
      assistantEntry([todoWriteBlock([{ id: "1", content: "First version", status: "pending" }])]),
      assistantEntry([
        todoWriteBlock([
          { id: "1", content: "First version", status: "completed" },
          { id: "2", content: "Second task", status: "in_progress" },
        ]),
      ]),
    ];

    const result = extractTodosFromTranscript(entries);
    expect(result).toHaveLength(2);
    expect(result?.[0].status).toBe("completed");
  });

  it("ignores outbound entries", () => {
    const entry: TranscriptEntry = {
      timestamp: Date.now(),
      direction: "outbound",
      message: {
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [todoWriteBlock([{ id: "1", content: "Task", status: "pending" }])],
        },
      },
    };

    expect(extractTodosFromTranscript([entry])).toBeNull();
  });

  it("ignores TodoWrite with empty todos array", () => {
    const entries = [assistantEntry([todoWriteBlock([])])];
    expect(extractTodosFromTranscript(entries)).toBeNull();
  });
});

// ── todosToPlan ──

describe("todosToPlan", () => {
  it("converts todos to a Plan with correct statuses", () => {
    const todos = [
      { id: "1", content: "Setup", status: "completed" as const },
      { id: "2", content: "Implement", status: "in_progress" as const },
      { id: "3", content: "Test", status: "pending" as const },
    ];

    const plan = todosToPlan(todos, "session-abc123");
    expect(plan.id).toBe("claude-session-abc123");
    expect(plan.name).toBe("Session session-");
    expect(plan.server).toBe("_claude");
    expect(plan.status).toBe("active");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].status).toBe("complete");
    expect(plan.steps[1].status).toBe("active");
    expect(plan.steps[2].status).toBe("pending");
    expect(plan.activeStepId).toBe("2");
  });

  it("sets plan status to complete when all todos are completed", () => {
    const todos = [
      { id: "1", content: "Done", status: "completed" as const },
      { id: "2", content: "Also done", status: "completed" as const },
    ];

    const plan = todosToPlan(todos, "sess-1");
    expect(plan.status).toBe("complete");
    expect(plan.activeStepId).toBeUndefined();
  });

  it("sets plan status to pending when no todos are active or completed", () => {
    const todos = [
      { id: "1", content: "Not started", status: "pending" as const },
      { id: "2", content: "Also not started", status: "pending" as const },
    ];

    const plan = todosToPlan(todos, "sess-2");
    expect(plan.status).toBe("pending");
  });
});

// ── parseClaudePlanMarkdown ──

describe("parseClaudePlanMarkdown", () => {
  it("parses phases from headings with checkbox tasks", () => {
    const md = `## Phase 1: Setup
- [x] Read existing code
- [x] Understand patterns

## Phase 2: Implementation
- [ ] Create adapter
- [x] Write types

## Phase 3: Testing
- [ ] Run tests
- [ ] Check coverage`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "session-abc");
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(3);
    expect(plan?.steps[0].name).toBe("Phase 1: Setup");
    expect(plan?.steps[0].status).toBe("complete");
    expect(plan?.steps[1].name).toBe("Phase 2: Implementation");
    expect(plan?.steps[1].status).toBe("active");
    expect(plan?.steps[2].name).toBe("Phase 3: Testing");
    expect(plan?.steps[2].status).toBe("pending");
    expect(plan?.status).toBe("active");
    expect(plan?.server).toBe("_claude");
  });

  it("returns null for empty markdown", () => {
    expect(parseClaudePlanMarkdown("", "plan-1", "sess")).toBeNull();
  });

  it("returns null for markdown without checkboxes", () => {
    const md = `## Some Heading
Just regular text here.`;
    expect(parseClaudePlanMarkdown(md, "plan-1", "sess")).toBeNull();
  });

  it("handles single-level headings (#)", () => {
    const md = `# Phase 1
- [x] Done task
- [ ] Pending task`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0].status).toBe("active");
  });

  it("handles uppercase X in checkboxes", () => {
    const md = `## Phase
- [X] Done with uppercase
- [ ] Not done`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan?.steps[0].status).toBe("active");
  });

  it("handles asterisk bullet points", () => {
    const md = `## Phase
* [x] Done task
* [ ] Pending task`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan).not.toBeNull();
    expect(plan?.steps[0].status).toBe("active");
  });

  it("does not set activeStepId when all steps are pending", () => {
    const md = `## Phase 1
- [ ] Task A

## Phase 2
- [ ] Task B`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan?.activeStepId).toBeUndefined();
    expect(plan?.status).toBe("pending");
  });

  it("sets plan status to complete when all phases are complete", () => {
    const md = `## Phase 1
- [x] Task A

## Phase 2
- [x] Task B
- [x] Task C`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan?.status).toBe("complete");
  });

  it("generates positional step IDs", () => {
    const md = `## Phase 1: Setup
- [x] Task A

## Phase 2: Implementation
- [ ] Task B`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan?.steps[0].id).toBe("phase-0");
    expect(plan?.steps[1].id).toBe("phase-1");
  });

  it("skips headings without checkbox tasks", () => {
    const md = `## Intro
Some context here.

## Phase 1: Work
- [x] Task A
- [ ] Task B

## Notes
More text.`;

    const plan = parseClaudePlanMarkdown(md, "plan-1", "sess");
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0].name).toBe("Phase 1: Work");
  });
});

// ── looksLikePlan ──

describe("looksLikePlan", () => {
  it("returns true for markdown with plan-keyword headings and checkboxes", () => {
    expect(looksLikePlan("## Phase 1\n- [x] Done")).toBe(true);
  });

  it("returns true for step keyword in heading", () => {
    expect(looksLikePlan("## Step 1: Setup\n- [ ] Do something")).toBe(true);
  });

  it("returns true for task keyword in heading", () => {
    expect(looksLikePlan("## Task: Build\n- [x] Done")).toBe(true);
  });

  it("returns true for multiple sections with checkboxes (no keywords)", () => {
    const md = "## Section A\n- [x] Done\n## Section B\n- [ ] Pending";
    expect(looksLikePlan(md)).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(looksLikePlan("Hello world")).toBe(false);
  });

  it("returns false for headings without checkboxes", () => {
    expect(looksLikePlan("## Heading\nSome text")).toBe(false);
  });

  it("returns false for checkboxes without headings", () => {
    expect(looksLikePlan("- [x] Task one\n- [ ] Task two")).toBe(false);
  });

  it("returns false for single non-keyword heading with checkboxes (PR checklist)", () => {
    expect(looksLikePlan("## Checklist\n- [x] Tests pass\n- [ ] Reviewed")).toBe(false);
  });

  it("returns false for README-style content with one heading and checkboxes", () => {
    expect(looksLikePlan("## Requirements\n- [x] Node 18+\n- [ ] Bun runtime")).toBe(false);
  });
});

// ── extractPlansFromTranscript ──

describe("extractPlansFromTranscript", () => {
  it("returns null when transcript is empty", () => {
    expect(extractPlansFromTranscript([], "sess-1")).toBeNull();
  });

  it("prefers TodoWrite structured data over markdown", () => {
    const entries = [
      assistantEntry([
        textBlock("## Phase\n- [x] Task A\n- [ ] Task B"),
        todoWriteBlock([{ id: "1", content: "Real task", status: "pending" }]),
      ]),
    ];

    const plan = extractPlansFromTranscript(entries, "sess-1");
    expect(plan).not.toBeNull();
    expect(plan?.steps[0].name).toBe("Real task");
  });

  it("falls back to markdown when no TodoWrite blocks exist", () => {
    const entries = [
      assistantEntry([textBlock("## Phase 1: Setup\n- [x] Task A\n- [ ] Task B\n\n## Phase 2: Build\n- [ ] Task C")]),
    ];

    const plan = extractPlansFromTranscript(entries, "sess-1");
    expect(plan).not.toBeNull();
    expect(plan?.steps[0].name).toBe("Phase 1: Setup");
  });

  it("returns null when transcript has no plan data", () => {
    const entries = [assistantEntry([textBlock("Just a normal message")])];
    expect(extractPlansFromTranscript(entries, "sess-1")).toBeNull();
  });

  it("uses the last markdown plan when multiple exist", () => {
    const entries = [
      assistantEntry([textBlock("## Phase 1: Old\n- [ ] Old task\n\n## Phase 2: Also old\n- [ ] Another")]),
      assistantEntry([textBlock("## Phase 1: New\n- [x] New task\n\n## Phase 2: Also new\n- [ ] Pending")]),
    ];

    const plan = extractPlansFromTranscript(entries, "sess-1");
    expect(plan).not.toBeNull();
    expect(plan?.steps[0].name).toBe("Phase 1: New");
    expect(plan?.steps[0].status).toBe("complete");
  });
});
