import { describe, expect, test } from "bun:test";
import { type MergePrDeps, type MergeResult, mergePr } from "./done-fn";

function makeDeps(overrides: Partial<MergePrDeps> = {}): MergePrDeps {
  return {
    async gh(_op) {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async prMerge(_prNumber, _flags) {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async prView(_prNumber, _fields, _jqExpr?) {
      return "MERGED";
    },
    async spawn(_cmd, _opts?) {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    ...overrides,
  };
}

describe("mergePr", () => {
  test("succeeds when labels include qa:pass and CI is green", async () => {
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prNumber).toBe(42);
  });

  test("returns missing_qa_pass when qa:pass label is absent", async () => {
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "bug", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_qa_pass");
  });

  test("blocks merge when the PR still carries review:changes (#2804)", async () => {
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass\nreview:pass\nreview:changes", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("inconsistent_labels");
      expect(result.blockingLabels).toContain("review:changes");
    }
  });

  test("blocks merge when qa:pass and qa:fail are both present (#2804)", async () => {
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass\nqa:fail", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("inconsistent_labels");
      expect(result.blockingLabels).toEqual(expect.arrayContaining(["qa:pass", "qa:fail"]));
    }
  });

  test("returns ci_not_green when failing checks > 0", async () => {
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "2", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ci_not_green");
  });

  test("recovers from interrupted merge when prView returns MERGED", async () => {
    // Simulates the SIGTERM race: prMerge exits non-zero but the server
    // actually completed the merge. prView must return "MERGED" for the
    // done phase to treat it as ok:true (Finding 4 fix).
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async prMerge(_prNumber, _flags) {
        return { stdout: "", stderr: "signal: interrupt", exitCode: 1 };
      },
      async prView(_prNumber, _fields, _jqExpr?) {
        return "MERGED";
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prNumber).toBe(42);
      expect(result.localCleanup).toBeDefined();
    }
  });

  test("returns merge_failed when interrupted merge prView returns non-MERGED", async () => {
    // Merge genuinely failed (not just client-side SIGTERM): prView says CLOSED
    // (not MERGED), so done phase must not treat it as success.
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async prMerge(_prNumber, _flags) {
        return { stdout: "", stderr: "merge failed: unknown error", exitCode: 1 };
      },
      async prView(_prNumber, _fields, _jqExpr?) {
        return "CLOSED";
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("merge_failed");
  });

  test("returns conflicts when merge stderr mentions conflicts", async () => {
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async prMerge(_prNumber, _flags) {
        return { stdout: "", stderr: "Pull Request is not mergeable due to conflict", exitCode: 1 };
      },
      async prView(_prNumber, _fields, _jqExpr?) {
        return "OPEN";
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflicts");
  });

  test("returns ok:true when concurrent rerun sees 'not mergeable' but PR is already MERGED", async () => {
    // Concurrent rerun scenario: a previous done invocation already merged the PR
    // server-side. The second call gets "Pull Request is not mergeable" from GitHub,
    // which must NOT be classified as conflicts — prView confirms MERGED, so ok:true.
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async prMerge(_prNumber, _flags) {
        return { stdout: "", stderr: "Pull Request is not mergeable", exitCode: 1 };
      },
      async prView(_prNumber, _fields, _jqExpr?) {
        return "MERGED";
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prNumber).toBe(42);
  });

  test("falls back to conflicts classification when prView fails and stderr matches", async () => {
    // prView is unreachable (network error), so we fall back to deterministic
    // stderr pattern matching — "not mergeable" is classified as conflicts.
    const deps = makeDeps({
      async gh(op) {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:checks") return { stdout: "0", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async prMerge(_prNumber, _flags) {
        return { stdout: "", stderr: "Pull Request is not mergeable due to conflict", exitCode: 1 };
      },
      async prView(_prNumber, _fields, _jqExpr?) {
        throw new Error("network unreachable");
      },
    });
    const result = await mergePr(42, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflicts");
  });
});
