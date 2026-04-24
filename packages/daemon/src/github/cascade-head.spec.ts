import { describe, expect, test } from "bun:test";
import type { MergeStatePR } from "./cascade-head";
import { computeCascadeHead } from "./cascade-head";

function pr(
  prNumber: number,
  mergeStateStatus: MergeStatePR["mergeStateStatus"],
  autoMergeEnabled: boolean,
  updatedAt: string,
): MergeStatePR {
  return { prNumber, mergeStateStatus, autoMergeEnabled, updatedAt };
}

describe("computeCascadeHead", () => {
  test("returns null for empty list", () => {
    expect(computeCascadeHead([])).toBeNull();
  });

  test("returns null when no PRs have auto-merge enabled", () => {
    const prs = [pr(1, "CLEAN", false, "2024-01-01T00:00:00Z"), pr(2, "BEHIND", false, "2024-01-01T00:01:00Z")];
    expect(computeCascadeHead(prs)).toBeNull();
  });

  test("returns null when all armed PRs are DIRTY/BLOCKED/UNKNOWN", () => {
    const prs = [
      pr(1, "DIRTY", true, "2024-01-01T00:00:00Z"),
      pr(2, "BLOCKED", true, "2024-01-01T00:01:00Z"),
      pr(3, "UNKNOWN", true, "2024-01-01T00:02:00Z"),
    ];
    expect(computeCascadeHead(prs)).toBeNull();
  });

  test("prefers CLEAN over BEHIND", () => {
    const prs = [
      pr(1, "BEHIND", true, "2024-01-01T00:00:00Z"),
      pr(2, "CLEAN", true, "2024-01-01T00:01:00Z"),
      pr(3, "BEHIND", true, "2024-01-01T00:02:00Z"),
    ];
    expect(computeCascadeHead(prs)).toBe(2);
  });

  test("FIFO tiebreak on updatedAt among CLEAN PRs", () => {
    const prs = [
      pr(10, "CLEAN", true, "2024-01-02T00:00:00Z"),
      pr(7, "CLEAN", true, "2024-01-01T00:00:00Z"),
      pr(15, "CLEAN", true, "2024-01-03T00:00:00Z"),
    ];
    expect(computeCascadeHead(prs)).toBe(7); // earliest updatedAt
  });

  test("FIFO tiebreak on updatedAt among BEHIND PRs when no CLEAN", () => {
    const prs = [
      pr(10, "BEHIND", true, "2024-01-02T00:00:00Z"),
      pr(7, "BEHIND", true, "2024-01-01T00:00:00Z"),
      pr(15, "BEHIND", true, "2024-01-03T00:00:00Z"),
    ];
    expect(computeCascadeHead(prs)).toBe(7); // earliest updatedAt
  });

  test("single PR: BEHIND→CLEAN transition results in itself as cascadeHead", () => {
    const prs = [pr(42, "CLEAN", true, "2024-01-01T00:00:00Z")];
    expect(computeCascadeHead(prs)).toBe(42);
  });

  test("ignores non-auto-merge PRs when selecting head", () => {
    const prs = [
      pr(1, "CLEAN", false, "2024-01-01T00:00:00Z"), // not armed
      pr(2, "BEHIND", true, "2024-01-01T00:01:00Z"), // armed
    ];
    expect(computeCascadeHead(prs)).toBe(2);
  });

  test("mixed auto-merge matrix: 2 CLEAN armed, 3 BEHIND armed, 2 non-armed", () => {
    const prs = [
      pr(1, "BEHIND", true, "2024-01-01T01:00:00Z"),
      pr(2, "CLEAN", true, "2024-01-01T02:00:00Z"),
      pr(3, "BEHIND", true, "2024-01-01T03:00:00Z"),
      pr(4, "CLEAN", true, "2024-01-01T01:30:00Z"), // earlier than pr2
      pr(5, "DIRTY", true, "2024-01-01T00:30:00Z"),
      pr(6, "CLEAN", false, "2024-01-01T00:00:00Z"), // not armed
      pr(7, "BEHIND", false, "2024-01-01T00:00:00Z"), // not armed
    ];
    // CLEAN armed: pr4 (01:30) and pr2 (02:00) → earliest = pr4
    expect(computeCascadeHead(prs)).toBe(4);
  });

  test("HAS_HOOKS and UNSTABLE are not actionable", () => {
    const prs = [pr(1, "HAS_HOOKS", true, "2024-01-01T00:00:00Z"), pr(2, "UNSTABLE", true, "2024-01-01T00:01:00Z")];
    expect(computeCascadeHead(prs)).toBeNull();
  });

  test("UNSTABLE armed PR with a BEHIND armed PR falls back to BEHIND", () => {
    const prs = [pr(1, "UNSTABLE", true, "2024-01-01T00:00:00Z"), pr(2, "BEHIND", true, "2024-01-01T00:01:00Z")];
    expect(computeCascadeHead(prs)).toBe(2);
  });

  test("PR with current-time sentinel updatedAt loses FIFO to legitimately older PRs", () => {
    // Simulates a PR whose updatedAt was missing and got the now() fallback.
    const nowSentinel = new Date(Date.now()).toISOString();
    const prs = [
      pr(1, "BEHIND", true, "2024-01-01T00:00:00Z"), // oldest — should win
      pr(2, "BEHIND", true, nowSentinel), // missing updatedAt fallback — should lose
    ];
    expect(computeCascadeHead(prs)).toBe(1);
  });
});
