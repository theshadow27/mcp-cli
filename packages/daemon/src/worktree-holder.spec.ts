import { describe, expect, test } from "bun:test";
import {
  ALLOW_SHARED_WORKTREE_ARG,
  type HolderRow,
  type SessionLookup,
  SharedWorktreeError,
  SharedWorktreeGuard,
  isHoldingSession,
} from "./worktree-holder";

const WT = "/repo/.claude/worktrees/issue-1328";

function row(over: Partial<HolderRow> = {}): HolderRow {
  return {
    sessionId: "sess-a",
    name: "Alice",
    provider: "claude",
    state: "active",
    cwd: WT,
    pid: 4242,
    pidStartTime: 1_700_000_000_000,
    endedAt: null,
    ...over,
  };
}

function lookup(rows: HolderRow[]): SessionLookup {
  return {
    listSessions: (active?: boolean) =>
      active === true
        ? rows.filter((r) => r.endedAt === null)
        : active === false
          ? rows.filter((r) => r.endedAt !== null)
          : rows,
  };
}

/** Every pid is alive unless the test says otherwise. `realpath` is identity — no fs. */
function guard(
  rows: HolderRow[],
  over: { isAlive?: (pid: number, s: number | null) => boolean; warn?: (m: string) => void } = {},
) {
  return new SharedWorktreeGuard(lookup(rows), {
    isAlive: over.isAlive ?? (() => true),
    realpath: (p) => p,
    warn: over.warn ?? (() => {}),
  });
}

// ── isHoldingSession: the definition of "live" ──

describe("isHoldingSession", () => {
  const alive = () => true;
  const dead = () => false;

  test("an active session with a live pid holds its directory", () => {
    expect(isHoldingSession(row(), alive)).toBe(true);
  });

  test("an ended session does not hold its directory — this is the sequential handoff case", () => {
    // `bye --keep-worktree` preserves the DIRECTORY, never the claim on it. The
    // impl → review → repair → QA pipeline reuses one worktree across sessions,
    // so a false positive here stops every sprint.
    expect(isHoldingSession(row({ state: "ended", endedAt: "2026-08-25T10:00:00Z" }), alive)).toBe(false);
  });

  test("state 'ended' alone is enough, even if ended_at was never written", () => {
    expect(isHoldingSession(row({ state: "ended" }), alive)).toBe(false);
  });

  test("a crashed session with a dead pid does not hold its directory", () => {
    // The reaper only runs at daemon startup, so a crashed session leaves an
    // active row behind indefinitely. Refusing on one would wedge the pipeline.
    expect(isHoldingSession(row(), dead)).toBe(false);
  });

  test("a session with no pid yet holds its directory — the spawn is in flight", () => {
    expect(isHoldingSession(row({ state: "connecting", pid: null, pidStartTime: null }), dead)).toBe(true);
  });

  test("a disconnected session with a live process still holds its directory", () => {
    expect(isHoldingSession(row({ state: "disconnected" }), alive)).toBe(true);
  });
});

// ── The refusal ──

describe("SharedWorktreeGuard.check — refusal", () => {
  test("refuses a spawn into a directory a live session holds", () => {
    const g = guard([row()]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT })).toThrow(SharedWorktreeError);
  });

  test("the refusal names the holding session, its provider, and the override flag", () => {
    const g = guard([row({ sessionId: "22854d06", provider: "mock", name: null, state: "running" })]);
    const refuse = () => g.check("_mock", "mock_prompt", { prompt: "hi", cwd: WT });
    expect(refuse).toThrow("22854d06");
    expect(refuse).toThrow(WT);
    expect(refuse).toThrow("--allow-shared-worktree");
    // The way out has to be in the message: nobody hitting this reads the source.
    expect(refuse).toThrow("mcx agent mock bye 22854d06");
  });

  test("counts every holder when more than one session is already colliding", () => {
    const g = guard([row({ sessionId: "a" }), row({ sessionId: "b" })]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT })).toThrow("2 live sessions");
  });
});

// ── What it must NOT refuse ──

describe("SharedWorktreeGuard.check — permitted", () => {
  test("allows the sequential handoff: spawn into the worktree of an ended session", () => {
    const ended = row({ state: "ended", endedAt: "2026-08-25T10:00:00Z" });
    const g = guard([ended]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT })).not.toThrow();
  });

  test("allows a spawn when the holder's process is dead", () => {
    const g = guard([row()], { isAlive: () => false });
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT })).not.toThrow();
  });

  test("allows a sibling worktree under the same repo", () => {
    const g = guard([row()]);
    expect(() =>
      g.check("_claude", "claude_prompt", { prompt: "hi", cwd: "/repo/.claude/worktrees/issue-935" }),
    ).not.toThrow();
  });

  test("exact paths only — a session at the repo root does not block worktrees beneath it", () => {
    // A prefix rule would make one session sitting at `/repo` refuse every
    // worktree spawn under `/repo/.claude/worktrees/`.
    const g = guard([row({ cwd: "/repo" })]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT })).not.toThrow();
  });

  test("exact paths only — a session in a subdirectory does not block its parent", () => {
    const g = guard([row({ cwd: `${WT}/packages/core` })]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT })).not.toThrow();
  });

  test("a follow-up prompt to an existing session is not a second agent", () => {
    // `sessionId` present means "send to the session already in that tree".
    const g = guard([row()]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT, sessionId: "sess-a" })).not.toThrow();
  });

  test("a spawn with no cwd is not checked", () => {
    const g = guard([row({ cwd: null })]);
    expect(() => g.check("_claude", "claude_prompt", { prompt: "hi" })).not.toThrow();
  });
});

// ── The override ──

describe("SharedWorktreeGuard.check — --allow-shared-worktree", () => {
  test("the override permits the spawn", () => {
    const g = guard([row()]);
    expect(() =>
      g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT, [ALLOW_SHARED_WORKTREE_ARG]: true }),
    ).not.toThrow();
  });

  test("the override is logged, naming the session it is overriding", () => {
    const warnings: string[] = [];
    const g = guard([row({ sessionId: "sess-a" })], { warn: (m) => warnings.push(m) });
    g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT, [ALLOW_SHARED_WORKTREE_ARG]: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sess-a");
    expect(warnings[0]).toContain("--allow-shared-worktree");
  });

  test("the override logs nothing when there was no collision to override", () => {
    const warnings: string[] = [];
    const g = guard([], { warn: (m) => warnings.push(m) });
    g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT, [ALLOW_SHARED_WORKTREE_ARG]: true });
    expect(warnings).toHaveLength(0);
  });

  test("the override never reaches a worker", () => {
    // A boundary decision. Forwarding it would hand a worker a flag it does not
    // implement and cannot honour.
    const g = guard([row()]);
    const out = g.check("_claude", "claude_prompt", { prompt: "hi", cwd: WT, [ALLOW_SHARED_WORKTREE_ARG]: true });
    expect(ALLOW_SHARED_WORKTREE_ARG in out.args).toBe(false);
    expect(out.args).toEqual({ prompt: "hi", cwd: WT });
  });
});

// ── Ownership: this runs for every callTool on the daemon ──

describe("SharedWorktreeGuard.check — ownership", () => {
  test("is a strict no-op for a third-party server, returning the same object", () => {
    const g = guard([row()]);
    const args = { cwd: WT, query: "x", [ALLOW_SHARED_WORKTREE_ARG]: true };
    const out = g.check("atlassian", "search", args);
    expect(out.args).toBe(args);
  });

  test("is a no-op for agent tools that are not spawns", () => {
    const g = guard([row()]);
    const args = { sessionId: "sess-a", cwd: WT };
    expect(g.check("_claude", "claude_bye", args).args).toBe(args);
  });

  test("guards every provider's spawn, not just claude", () => {
    for (const [server, tool] of [
      ["_claude", "claude_prompt"],
      ["_codex", "codex_prompt"],
      ["_acp", "acp_prompt"],
      ["_opencode", "opencode_prompt"],
      ["_mock", "mock_prompt"],
    ] as const) {
      const g = guard([row({ provider: server.slice(1) })]);
      expect(() => g.check(server, tool, { prompt: "hi", cwd: WT })).toThrow(SharedWorktreeError);
    }
  });
});

// ── In-flight reservations ──

describe("SharedWorktreeGuard.check — concurrent spawns", () => {
  test("a second spawn dispatched before the first registers its session is refused", () => {
    // Both spawns read a DB that has no row for either of them yet. Without the
    // reservation the guard is advisory: it cannot see the race it exists for.
    const g = guard([]);
    g.check("_claude", "claude_prompt", { prompt: "a", cwd: WT });
    expect(() => g.check("_claude", "claude_prompt", { prompt: "b", cwd: WT })).toThrow(/already in flight/);
  });

  test("releasing the first spawn frees the directory again", () => {
    const g = guard([]);
    const first = g.check("_claude", "claude_prompt", { prompt: "a", cwd: WT });
    first.release();
    expect(() => g.check("_claude", "claude_prompt", { prompt: "b", cwd: WT })).not.toThrow();
  });

  test("release is idempotent — a double release cannot free someone else's claim", () => {
    const g = guard([]);
    const first = g.check("_claude", "claude_prompt", { prompt: "a", cwd: WT });
    const other = g.check("_claude", "claude_prompt", { prompt: "b", cwd: "/other" });
    first.release();
    first.release();
    other.release();
    expect(() => g.check("_claude", "claude_prompt", { prompt: "c", cwd: "/other" })).not.toThrow();
  });

  test("release is idempotent — a double release on ONE directory cannot free a concurrent claim on that same directory", () => {
    // The previous test double-releases `first` (WT) and asserts on `other`
    // (/other) — a different cwd, so it can't detect a broken idempotency
    // guard: decrementing WT twice never touches /other's counter regardless
    // of whether `reserve()`'s `released` flag actually works. Only two
    // reservations sharing ONE cwd can pin this, and only the
    // --allow-shared-worktree path can construct that (a plain second spawn to
    // an already-pending cwd throws "already in flight" before it can reserve).
    const g = guard([]);
    const first = g.check("_claude", "claude_prompt", {
      prompt: "a",
      cwd: WT,
      [ALLOW_SHARED_WORKTREE_ARG]: true,
    });
    const second = g.check("_claude", "claude_prompt", {
      prompt: "b",
      cwd: WT,
      [ALLOW_SHARED_WORKTREE_ARG]: true,
    });
    first.release();
    first.release();
    // second's reservation must still be held: a plain (non-override) spawn
    // into WT is still refused as in-flight.
    expect(() => g.check("_claude", "claude_prompt", { prompt: "c", cwd: WT })).toThrow(/already in flight/);
    second.release();
    expect(() => g.check("_claude", "claude_prompt", { prompt: "d", cwd: WT })).not.toThrow();
  });

  test("an in-flight spawn does not block a different directory", () => {
    const g = guard([]);
    g.check("_claude", "claude_prompt", { prompt: "a", cwd: WT });
    expect(() => g.check("_claude", "claude_prompt", { prompt: "b", cwd: "/other" })).not.toThrow();
  });
});

// ── Path normalization ──

describe("SharedWorktreeGuard.holdersOf", () => {
  test("compares directories after realpath resolution", () => {
    const g = new SharedWorktreeGuard(lookup([row({ cwd: "/private/repo/wt" })]), {
      isAlive: () => true,
      realpath: (p) => (p === "/repo/wt" ? "/private/repo/wt" : p),
    });
    expect(g.holdersOf("/repo/wt")).toHaveLength(1);
  });

  test("an unresolvable path falls back to the raw string rather than failing the spawn", () => {
    const g = new SharedWorktreeGuard(lookup([row({ cwd: WT })]), {
      isAlive: () => true,
      realpath: () => {
        throw new Error("ENOENT");
      },
    });
    expect(g.holdersOf(WT)).toHaveLength(1);
  });
});
