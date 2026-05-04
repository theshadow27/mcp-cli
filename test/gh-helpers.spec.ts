import { describe, expect, test } from "bun:test";
import { type GhResult, gh, prComment, prEdit, prList, prMerge, prView, spawn } from "../.claude/phases/gh";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "oops"): GhResult {
  return { stdout: "", stderr, exitCode: 1 };
}

// ── prView ──

describe("prView — argument construction", () => {
  test("builds args without jqExpr", async () => {
    let captured: string[] | undefined;
    await prView(42, "state,title", undefined, async (args) => {
      captured = args;
      return ok('{"state":"OPEN"}');
    });
    expect(captured).toEqual(["pr", "view", "42", "--json", "state,title"]);
  });

  test("builds args with jqExpr", async () => {
    let captured: string[] | undefined;
    await prView(42, "state", ".state", async (args) => {
      captured = args;
      return ok("OPEN");
    });
    expect(captured).toEqual(["pr", "view", "42", "--json", "state", "-q", ".state"]);
  });

  test("returns stdout on success", async () => {
    const result = await prView(42, "state", ".state", async () => ok("MERGED"));
    expect(result).toBe("MERGED");
  });

  test("throws on non-zero exit", async () => {
    await expect(prView(42, "state", undefined, async () => fail("not found"))).rejects.toThrow(
      "gh pr view 42 failed (exit 1): not found",
    );
  });
});

// ── prList ──

describe("prList — argument construction", () => {
  test("builds args with no opts", async () => {
    let captured: string[] | undefined;
    await prList({}, async (args) => {
      captured = args;
      return ok("[]");
    });
    expect(captured).toEqual(["pr", "list"]);
  });

  test("builds args with head", async () => {
    let captured: string[] | undefined;
    await prList({ head: "feat/my-branch" }, async (args) => {
      captured = args;
      return ok("[]");
    });
    expect(captured).toEqual(["pr", "list", "--head", "feat/my-branch"]);
  });

  test("builds args with json + jq", async () => {
    let captured: string[] | undefined;
    await prList({ json: "number,title", jq: ".[0].number" }, async (args) => {
      captured = args;
      return ok("123");
    });
    expect(captured).toEqual(["pr", "list", "--json", "number,title", "-q", ".[0].number"]);
  });

  test("throws on non-zero exit", async () => {
    await expect(prList({}, async () => fail("auth failed"))).rejects.toThrow(
      "gh pr list failed (exit 1): auth failed",
    );
  });
});

// ── prEdit ──

describe("prEdit — argument construction", () => {
  test("builds args with flags", async () => {
    let captured: string[] | undefined;
    await prEdit(99, ["--add-label", "qa:pass"], async (args) => {
      captured = args;
      return ok();
    });
    expect(captured).toEqual(["pr", "edit", "99", "--add-label", "qa:pass"]);
  });

  test("throws on non-zero exit", async () => {
    await expect(prEdit(99, ["--add-label", "qa:pass"], async () => fail("forbidden"))).rejects.toThrow(
      "gh pr edit 99 failed (exit 1): forbidden",
    );
  });
});

// ── prMerge ──

describe("prMerge — argument construction", () => {
  test("builds args with flags", async () => {
    let captured: string[] | undefined;
    await prMerge(77, ["--squash", "--delete-branch"], async (args) => {
      captured = args;
      return ok();
    });
    expect(captured).toEqual(["pr", "merge", "77", "--squash", "--delete-branch"]);
  });

  test("returns result even on non-zero exit (no throw)", async () => {
    const result = await prMerge(77, [], async () => fail("conflict"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("conflict");
  });
});

// ── prComment ──

describe("prComment — argument construction", () => {
  test("builds args with body", async () => {
    let captured: string[] | undefined;
    await prComment(55, "hello world", async (args) => {
      captured = args;
      return ok();
    });
    expect(captured).toEqual(["pr", "comment", "55", "--body", "hello world"]);
  });

  test("throws on non-zero exit", async () => {
    await expect(prComment(55, "body", async () => fail("rate limited"))).rejects.toThrow(
      "gh pr comment 55 failed (exit 1): rate limited",
    );
  });
});

// ── SIGKILL escalation ──

describe("spawn — timeout kills process", () => {
  test("SIGTERM kills an ordinary slow process within timeout window", async () => {
    const start = Date.now();
    // sleep responds to SIGTERM immediately
    const result = await spawn(["sleep", "60"], { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(result.exitCode).not.toBe(0);
  });

  test("SIGKILL escalation: kills process that ignores SIGTERM", async () => {
    const start = Date.now();
    // Single-process bun script ignoring SIGTERM — pipe closes only on SIGKILL
    const result = await spawn(["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
      timeoutMs: 100,
      sigkillDelayMs: 100,
    });
    const elapsed = Date.now() - start;
    // Should be SIGKILL'd after ~200ms, not 60 seconds
    expect(elapsed).toBeLessThan(3_000);
    expect(result.exitCode).not.toBe(0);
  }, 5000);
});
