import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModelInSprintPlan, parseModelFromSprintTable } from "./sprint-plan";

const SPRINT_TABLE = `# Sprint 38

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1441** | feat: worktree containment | high | 1 | opus | anchor |
| **1437** | fix(phases): impl model | low | 2 | sonnet | DX |
| **1426** | bug: session balloons | medium | 2 | opus | containment |
| **1385** | fix: truncate forceMessage | low | 2 | sonnet | polish |
`;

describe("parseModelFromSprintTable", () => {
  test("returns model for matching issue (bold formatting)", () => {
    expect(parseModelFromSprintTable(SPRINT_TABLE, 1437)).toBe("sonnet");
  });

  test("returns opus for opus-assigned issue", () => {
    expect(parseModelFromSprintTable(SPRINT_TABLE, 1441)).toBe("opus");
  });

  test("returns null when issue not in table", () => {
    expect(parseModelFromSprintTable(SPRINT_TABLE, 9999)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseModelFromSprintTable("", 1437)).toBeNull();
  });

  test("returns null when no Model column", () => {
    const noModel = "| # | Title | Scrutiny |\n|---|-------|----------|\n| 1437 | foo | low |\n";
    expect(parseModelFromSprintTable(noModel, 1437)).toBeNull();
  });

  test("handles plain (non-bold) issue numbers", () => {
    const plain = "| # | Title | Model |\n|---|-------|-------|\n| 1437 | foo | sonnet |\n";
    expect(parseModelFromSprintTable(plain, 1437)).toBe("sonnet");
  });

  test("is case-insensitive for model value", () => {
    const upper = "| # | Title | Model |\n|---|-------|-------|\n| 1437 | foo | Sonnet |\n";
    expect(parseModelFromSprintTable(upper, 1437)).toBe("sonnet");
  });

  test("returns null for unknown model values", () => {
    const bad = "| # | Title | Model |\n|---|-------|-------|\n| 1437 | foo | gpt4 |\n";
    expect(parseModelFromSprintTable(bad, 1437)).toBeNull();
  });

  test("handles multiple tables — picks correct one", () => {
    const twoTables =
      "## Batch 1\n\n| # | Title | Model |\n|---|-------|-------|\n| 1000 | other | opus |\n\n## Batch 2\n\n| # | Title | Model |\n|---|-------|-------|\n| 1437 | impl | sonnet |\n";
    expect(parseModelFromSprintTable(twoTables, 1437)).toBe("sonnet");
  });
});

describe("findModelInSprintPlan", () => {
  let tmpDir: string;
  let sprintDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sprint-plan-test-"));
    sprintDir = join(tmpDir, ".claude", "sprints");
    mkdirSync(sprintDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns model from the latest sprint file", () => {
    writeFileSync(join(sprintDir, "sprint-37.md"), SPRINT_TABLE.replace("1437", "9999"));
    writeFileSync(join(sprintDir, "sprint-38.md"), SPRINT_TABLE);
    expect(findModelInSprintPlan(1437, tmpDir)).toBe("sonnet");
  });

  test("falls back to an older sprint if not in latest", () => {
    writeFileSync(join(sprintDir, "sprint-37.md"), SPRINT_TABLE);
    writeFileSync(
      join(sprintDir, "sprint-38.md"),
      "| # | Title | Model |\n|---|-------|-------|\n| 9999 | other | opus |\n",
    );
    expect(findModelInSprintPlan(1437, tmpDir)).toBe("sonnet");
  });

  test("returns null when no sprint files exist", () => {
    expect(findModelInSprintPlan(1437, tmpDir)).toBeNull();
  });

  test("returns null when sprint dir does not exist", () => {
    expect(findModelInSprintPlan(1437, join(tmpDir, "nonexistent"))).toBeNull();
  });

  test("returns null when issue is not in any sprint", () => {
    writeFileSync(join(sprintDir, "sprint-38.md"), SPRINT_TABLE);
    expect(findModelInSprintPlan(9999, tmpDir)).toBeNull();
  });

  test("ignores non-sprint files in the directory", () => {
    writeFileSync(join(sprintDir, "notes.md"), SPRINT_TABLE);
    writeFileSync(
      join(sprintDir, "sprint-38.md"),
      "| # | Title | Model |\n|---|-------|-------|\n| 1437 | foo | opus |\n",
    );
    expect(findModelInSprintPlan(1437, tmpDir)).toBe("opus");
  });
});
