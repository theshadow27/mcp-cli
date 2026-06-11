import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContainmentGuard } from "./containment";

const WORKTREE = "/Users/test/repo/.claude/worktrees/my-worktree";

function guard(): ContainmentGuard {
  return new ContainmentGuard(WORKTREE);
}

// ── No-op for in-worktree operations ──

describe("ContainmentGuard — in-worktree operations", () => {
  test("allows Bash without git commands", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "ls -la" });
    expect(r.action).toBe("allow");
    expect(r.event).toBeUndefined();
  });

  test("allows git commit inside worktree (no explicit path)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git commit -m 'test'" });
    expect(r.action).toBe("allow");
  });

  test("allows Write inside worktree", () => {
    const g = guard();
    const r = g.evaluate("Write", { file_path: `${WORKTREE}/src/main.ts` });
    expect(r.action).toBe("allow");
  });

  test("allows Edit inside worktree", () => {
    const g = guard();
    const r = g.evaluate("Edit", { file_path: `${WORKTREE}/package.json`, old_string: "a", new_string: "b" });
    expect(r.action).toBe("allow");
  });

  test("allows MultiEdit inside worktree", () => {
    const g = guard();
    const r = g.evaluate("MultiEdit", { file_path: `${WORKTREE}/src/main.ts`, edits: [] });
    expect(r.action).toBe("allow");
  });

  test("allows Read inside worktree", () => {
    const g = guard();
    const r = g.evaluate("Read", { file_path: `${WORKTREE}/README.md` });
    expect(r.action).toBe("allow");
  });

  test("allows Glob inside worktree", () => {
    const g = guard();
    const r = g.evaluate("Glob", { path: `${WORKTREE}/src`, pattern: "**/*.ts" });
    expect(r.action).toBe("allow");
  });

  test("allows NotebookEdit inside worktree (notebook_path param)", () => {
    const g = guard();
    const r = g.evaluate("NotebookEdit", { notebook_path: `${WORKTREE}/nb.ipynb`, new_source: "x" });
    expect(r.action).toBe("allow");
  });

  test("allows known non-filesystem tools (Agent, TodoWrite, WebFetch)", () => {
    const g = guard();
    expect(g.evaluate("Agent", { prompt: "do something" }).action).toBe("allow");
    expect(g.evaluate("TodoWrite", { todos: [] }).action).toBe("allow");
    expect(g.evaluate("WebFetch", { url: "https://example.com" }).action).toBe("allow");
    expect(g.evaluate("ExitPlanMode", { plan: "x" }).action).toBe("allow");
  });

  test("allows read-only MCP discovery built-ins (no mcp__ prefix)", () => {
    const g = guard();
    expect(g.evaluate("ListMcpResourcesTool", {}).action).toBe("allow");
    expect(g.evaluate("ReadMcpResourceTool", { server: "s", uri: "u" }).action).toBe("allow");
  });

  test("allows MCP tools by prefix", () => {
    const g = guard();
    const r = g.evaluate("mcp__atlassian__search", { query: "test" });
    expect(r.action).toBe("allow");
    expect(r.event).toBeUndefined();
  });
});

// ── Fail-closed for unrecognized tools (#2520) ──

describe("ContainmentGuard — fail closed for unrecognized tools", () => {
  test("denies an unrecognized tool by default", () => {
    const g = guard();
    const r = g.evaluate("FutureWriteTool", { file_path: `${WORKTREE}/src/main.ts` });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denies an unrecognized tool even with no path argument", () => {
    const g = guard();
    const r = g.evaluate("SomeBrandNewTool", { foo: "bar" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denying an unrecognized tool does not consume a strike (no full lockout)", () => {
    const g = guard();
    for (let i = 0; i < 5; i++) {
      const r = g.evaluate("SomeBrandNewTool", { foo: "bar" });
      expect(r.action).toBe("deny");
    }
    expect(g.strikes).toBe(0);
    expect(g.escalated).toBe(false);
    // A legitimate in-worktree write still works afterwards.
    expect(g.evaluate("Write", { file_path: `${WORKTREE}/src/main.ts` }).action).toBe("allow");
  });

  test("denies a write tool whose path argument is missing (fail closed)", () => {
    const g = guard();
    const r = g.evaluate("Write", { content: "data" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denies NotebookEdit escaping the worktree (path-check is functional)", () => {
    const g = guard();
    const r = g.evaluate("NotebookEdit", { notebook_path: "/Users/test/repo/nb.ipynb", new_source: "x" });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });
});

// ── Absolute-path escape into the parent main checkout (#2693) ──
// A worktree lives at <main>/.claude/worktrees/<id>; the orchestrator's main
// checkout is its parent. Absolute paths quoted from issue investigation
// comments resolve into main, not the worktree, and must be denied.
describe("ContainmentGuard — absolute path into parent main checkout", () => {
  // WORKTREE = /Users/test/repo/.claude/worktrees/my-worktree → main = /Users/test/repo
  const MAIN = "/Users/test/repo";
  const strayFiles = [
    `${MAIN}/packages/command/src/commands/track.ts`,
    `${MAIN}/packages/command/src/commands/track.spec.ts`,
    `${MAIN}/packages/core/src/phase-transition.ts`,
    `${MAIN}/packages/core/src/phase-transition.spec.ts`,
  ];

  for (const file of strayFiles) {
    test(`denies Write to main-checkout path ${file}`, () => {
      const g = guard();
      const r = g.evaluate("Write", { file_path: file });
      expect(r.action).toBe("deny");
      expect(r.strikes).toBe(1);
    });

    test(`denies Edit to main-checkout path ${file}`, () => {
      const g = guard();
      const r = g.evaluate("Edit", { file_path: file, old_string: "a", new_string: "b" });
      expect(r.action).toBe("deny");
    });

    test(`denies MultiEdit to main-checkout path ${file}`, () => {
      const g = guard();
      const r = g.evaluate("MultiEdit", { file_path: file, edits: [] });
      expect(r.action).toBe("deny");
    });
  }
});

// ── Git write commands outside worktree ──

describe("ContainmentGuard — git writes outside worktree", () => {
  test("denies git -C <outside> commit on first attempt", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo commit -m 'bad'" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
    expect(r.reason).toContain("git commit");
    expect(r.strikes).toBe(0); // git writes don't increment strikes
  });

  test("denies cd <outside> && git push", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "cd /Users/test/repo && git push origin main" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denies cd <outside> && git checkout", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "cd /Users/test/repo && git checkout -b feat/bad" });
    expect(r.action).toBe("deny");
  });

  test("allows git -C <inside-worktree> commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `git -C ${WORKTREE}/subdir commit -m 'ok'` });
    expect(r.action).toBe("allow");
  });

  test("allows git log outside worktree (read-only)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo log --oneline" });
    expect(r.action).toBe("allow");
  });

  test("allows git status outside worktree (read-only)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo status" });
    expect(r.action).toBe("allow");
  });

  test("allows git diff outside worktree (read-only)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo diff" });
    expect(r.action).toBe("allow");
  });
});

// ── Write/Edit outside worktree (strike-counted) ──

describe("ContainmentGuard — file writes outside worktree", () => {
  test("denies Write outside worktree with strike 1", () => {
    const g = guard();
    const r = g.evaluate("Write", { file_path: "/Users/test/repo/src/main.ts" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
    expect(r.strikes).toBe(1);
  });

  test("denies Edit outside worktree with strike 2", () => {
    const g = guard();
    g.evaluate("Write", { file_path: "/Users/test/repo/a.ts" });
    const r = g.evaluate("Edit", { file_path: "/Users/test/repo/b.ts" });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(2);
  });

  test("denies MultiEdit outside worktree with strike", () => {
    const g = guard();
    const r = g.evaluate("MultiEdit", { file_path: "/Users/test/repo/src/main.ts", edits: [] });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
    expect(r.strikes).toBe(1);
  });

  test("escalates on 3rd strike", () => {
    const g = guard();
    g.evaluate("Write", { file_path: "/Users/test/repo/a.ts" });
    g.evaluate("Write", { file_path: "/Users/test/repo/b.ts" });
    const r = g.evaluate("Edit", { file_path: "/Users/test/repo/c.ts" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_escalated");
    expect(r.strikes).toBe(3);
    expect(g.escalated).toBe(true);
  });

  test("after escalation, all tool calls denied", () => {
    const g = guard();
    g.evaluate("Write", { file_path: "/Users/test/repo/a.ts" });
    g.evaluate("Write", { file_path: "/Users/test/repo/b.ts" });
    g.evaluate("Edit", { file_path: "/Users/test/repo/c.ts" });

    // Even in-worktree calls are denied after escalation
    const r = g.evaluate("Write", { file_path: `${WORKTREE}/ok.ts` });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_escalated");
  });

  test("allows Write to /tmp (no strike)", () => {
    const g = guard();
    const r = g.evaluate("Write", { file_path: "/tmp/scratch.txt" });
    expect(r.action).toBe("allow");
    expect(r.strikes).toBe(0);
  });

  test("allows Write to /private/tmp (macOS)", () => {
    const g = guard();
    const r = g.evaluate("Write", { file_path: "/private/tmp/test.json" });
    expect(r.action).toBe("allow");
    expect(r.strikes).toBe(0);
  });

  test("allows Write to //private/tmp (double-slash normalized by resolve)", () => {
    const g = guard();
    const r = g.evaluate("Write", { file_path: "//private/tmp/test.json" });
    expect(r.action).toBe("allow");
    expect(r.strikes).toBe(0);
  });

  test("allows shell redirect to //tmp (double-slash normalized)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: 'echo "x" > //tmp/scratch.txt' });
    expect(r.action).toBe("allow");
  });
});

// ── Read outside worktree (warn only) ──

describe("ContainmentGuard — reads outside worktree", () => {
  test("warns on Read outside worktree (no strike)", () => {
    const g = guard();
    const r = g.evaluate("Read", { file_path: "/Users/test/repo/CLAUDE.md" });
    expect(r.action).toBe("warn");
    expect(r.event).toBe("session:containment_warning");
    expect(r.strikes).toBe(0);
  });

  test("warns on Grep outside worktree (no strike)", () => {
    const g = guard();
    const r = g.evaluate("Grep", { path: "/Users/test/repo", pattern: "foo" });
    expect(r.action).toBe("warn");
    expect(r.event).toBe("session:containment_warning");
    expect(r.strikes).toBe(0);
  });

  test("warns on Glob outside worktree (no strike)", () => {
    const g = guard();
    const r = g.evaluate("Glob", { path: "/Users/test/repo", pattern: "**/*.ts" });
    expect(r.action).toBe("warn");
    expect(r.event).toBe("session:containment_warning");
  });

  test("multiple read warnings don't escalate", () => {
    const g = guard();
    for (let i = 0; i < 10; i++) {
      g.evaluate("Read", { file_path: `/Users/test/repo/file${i}.ts` });
    }
    expect(g.strikes).toBe(0);
    expect(g.escalated).toBe(false);
  });
});

// ── Edge cases ──

describe("ContainmentGuard — edge cases", () => {
  test("handles trailing slash in worktree root", () => {
    const g = new ContainmentGuard(`${WORKTREE}/`);
    const r = g.evaluate("Write", { file_path: `${WORKTREE}/src/ok.ts` });
    expect(r.action).toBe("allow");
  });

  test("handles worktree root itself as path", () => {
    const g = guard();
    const r = g.evaluate("Read", { file_path: WORKTREE });
    expect(r.action).toBe("allow");
  });

  test("prevents path traversal via prefix overlap", () => {
    const g = new ContainmentGuard("/Users/test/repo/.claude/worktrees/abc");
    const r = g.evaluate("Write", { file_path: "/Users/test/repo/.claude/worktrees/abcdef/evil.ts" });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("handles empty command in Bash", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "" });
    expect(r.action).toBe("allow");
  });

  test("handles missing command in Bash", () => {
    const g = guard();
    const r = g.evaluate("Bash", {});
    expect(r.action).toBe("allow");
  });

  test("denies Write with missing file_path (fail closed, #2520)", () => {
    const g = guard();
    const r = g.evaluate("Write", {});
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("git commands with flags before subcommand", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo --no-pager commit -m 'bad'" });
    expect(r.action).toBe("deny");
  });

  test("piped git commands outside worktree", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "cd /Users/test/repo && git add . && git commit -m 'bad'" });
    expect(r.action).toBe("deny");
  });

  test("git read-only commands in pipes are allowed", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo log | head -5" });
    expect(r.action).toBe("allow");
  });
});

// ── Adversarial: Bash file write bypass vectors ──

describe("ContainmentGuard — bash file write detection", () => {
  test("denies shell redirect > to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: 'echo "pwned" > /Users/test/repo/evil.ts' });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("denies shell append >> to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: 'echo "pwned" >> /Users/test/repo/evil.ts' });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("allows shell redirect to worktree path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `echo "ok" > ${WORKTREE}/output.txt` });
    expect(r.action).toBe("allow");
  });

  test("allows shell redirect to /tmp", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: 'echo "scratch" > /tmp/scratch.txt' });
    expect(r.action).toBe("allow");
  });

  test("denies cp to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `cp ${WORKTREE}/file.ts /Users/test/repo/file.ts` });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("denies mv to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `mv ${WORKTREE}/file.ts /Users/test/repo/file.ts` });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("denies tee to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "cat something | tee /Users/test/repo/output.log" });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("denies ln to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `ln -s ${WORKTREE}/file.ts /Users/test/repo/link.ts` });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("denies rsync to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `rsync -a ${WORKTREE}/src/ /Users/test/repo/src/` });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("denies install to outside path", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `install -m 755 ${WORKTREE}/bin/mcx /usr/local/bin/mcx` });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });

  test("allows cp between worktree paths", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `cp ${WORKTREE}/a.ts ${WORKTREE}/b.ts` });
    expect(r.action).toBe("allow");
  });

  test("bash write strikes accumulate like Write/Edit", () => {
    const g = guard();
    g.evaluate("Bash", { command: 'echo "1" > /Users/test/repo/a.ts' });
    g.evaluate("Bash", { command: "cp /Users/test/repo/x.ts /Users/test/repo/y.ts" });
    const r = g.evaluate("Bash", { command: 'echo "3" > /Users/test/repo/c.ts' });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_escalated");
    expect(r.strikes).toBe(3);
    expect(g.escalated).toBe(true);
  });

  test("bash write strikes mix with Write/Edit strikes", () => {
    const g = guard();
    g.evaluate("Write", { file_path: "/Users/test/repo/a.ts" });
    g.evaluate("Bash", { command: 'echo "2" > /Users/test/repo/b.ts' });
    const r = g.evaluate("Edit", { file_path: "/Users/test/repo/c.ts" });
    expect(r.strikes).toBe(3);
    expect(g.escalated).toBe(true);
  });

  test("chained commands: denies if any segment writes outside", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `ls ${WORKTREE} && cp ${WORKTREE}/a.ts /Users/test/repo/a.ts` });
    expect(r.action).toBe("deny");
    expect(r.strikes).toBe(1);
  });
});

// ── Adversarial: --work-tree / --git-dir bypass vectors ──

describe("ContainmentGuard — git --work-tree and --git-dir", () => {
  test("denies git --work-tree=/outside commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git --work-tree=/Users/test/repo commit -m 'escape'" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denies git --work-tree /outside commit (space-separated)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git --work-tree /Users/test/repo commit -m 'escape'" });
    expect(r.action).toBe("deny");
  });

  test("denies git --git-dir=/outside/.git commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git --git-dir=/Users/test/repo/.git commit -m 'escape'" });
    expect(r.action).toBe("deny");
  });

  test("denies git --git-dir /outside/.git commit (space-separated)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git --git-dir /Users/test/repo/.git commit -m 'escape'" });
    expect(r.action).toBe("deny");
  });

  test("allows git --work-tree=<inside-worktree> commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `git --work-tree=${WORKTREE} commit -m 'ok'` });
    expect(r.action).toBe("allow");
  });

  test("allows git --git-dir=<inside-worktree>/.git commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `git --git-dir=${WORKTREE}/.git commit -m 'ok'` });
    expect(r.action).toBe("allow");
  });
});

// ── Adversarial: env var prefix bypass vectors ──

describe("ContainmentGuard — env var prefix bypass", () => {
  test("denies GIT_DIR=/outside git commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "GIT_DIR=/Users/test/repo/.git git commit -m 'escape'" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denies GIT_WORK_TREE=/outside git commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "GIT_WORK_TREE=/Users/test/repo git commit -m 'escape'" });
    expect(r.action).toBe("deny");
  });

  test("denies combined GIT_DIR + GIT_WORK_TREE env vars", () => {
    const g = guard();
    const r = g.evaluate("Bash", {
      command: "GIT_DIR=/Users/test/repo/.git GIT_WORK_TREE=/Users/test/repo git commit -m 'escape'",
    });
    expect(r.action).toBe("deny");
  });

  test("allows GIT_DIR pointing inside worktree", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `GIT_DIR=${WORKTREE}/.git git commit -m 'ok'` });
    expect(r.action).toBe("allow");
  });

  test("extractGitSubcommand skips env var assignments to find git", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "FOO=bar GIT_DIR=/Users/test/repo/.git git commit -m 'escape'" });
    expect(r.action).toBe("deny");
  });
});

// ── Adversarial: pushd / subshell cd patterns ──

describe("ContainmentGuard — pushd and subshell cd", () => {
  test("denies pushd <outside> && git commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "pushd /Users/test/repo && git commit -m 'escape'" });
    expect(r.action).toBe("deny");
    expect(r.event).toBe("session:containment_denied");
  });

  test("denies subshell (cd <outside> && git commit)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "(cd /Users/test/repo && git commit -m 'escape')" });
    expect(r.action).toBe("deny");
  });

  test("denies bash -c 'cd <outside> && git commit'", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "bash -c 'cd /Users/test/repo && git commit -m escape'" });
    expect(r.action).toBe("deny");
  });

  test("allows pushd <inside-worktree> && git commit", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: `pushd ${WORKTREE} && git commit -m 'ok'` });
    expect(r.action).toBe("allow");
  });

  test("denies pushd <outside> ; git push (semicolon separator)", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "pushd /Users/test/repo; git push origin main" });
    expect(r.action).toBe("deny");
  });
});

// ── Adversarial: git clone and worktree add ──

describe("ContainmentGuard — git clone and worktree add", () => {
  test("denies git clone to outside path via -C", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo clone https://example.com/repo.git" });
    expect(r.action).toBe("deny");
  });

  test("denies git worktree add targeting outside via -C", () => {
    const g = guard();
    const r = g.evaluate("Bash", { command: "git -C /Users/test/repo worktree add ../escape-hatch" });
    expect(r.action).toBe("deny");
  });
});

// ── Symlink traversal (#1481) ──

describe("ContainmentGuard — symlink path traversal", () => {
  test("denies Write via symlink escaping worktree", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
    const worktree = join(base, "worktree");
    const outside = join(base, "outside");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // Create symlink inside worktree pointing to outside dir
    const symlink = join(worktree, "escape");
    symlinkSync(outside, symlink);

    try {
      const g = new ContainmentGuard(worktree);
      const r = g.evaluate("Write", { file_path: join(symlink, "evil.ts") });
      expect(r.action).toBe("deny");
      expect(r.strikes).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("denies Edit via symlink escaping worktree", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
    const worktree = join(base, "worktree");
    const outside = join(base, "outside");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const symlink = join(worktree, "escape");
    symlinkSync(outside, symlink);

    try {
      const g = new ContainmentGuard(worktree);
      const r = g.evaluate("Edit", { file_path: join(symlink, "evil.ts") });
      expect(r.action).toBe("deny");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("allows Write to real path inside worktree (not a symlink escape)", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
    const worktree = join(base, "worktree");
    const subdir = join(worktree, "src");
    mkdirSync(subdir, { recursive: true });

    try {
      const g = new ContainmentGuard(worktree);
      const r = g.evaluate("Write", { file_path: join(subdir, "ok.ts") });
      expect(r.action).toBe("allow");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("denies Write via symlink + non-existent subdir (multi-segment missing path)", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
    const worktree = join(base, "worktree");
    const outside = join(base, "outside");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // escape → outside; newdir does NOT exist inside outside
    const symlink = join(worktree, "escape");
    symlinkSync(outside, symlink);

    try {
      const g = new ContainmentGuard(worktree);
      // Two non-existent segments under the symlink: escape/newdir/evil.ts
      const r = g.evaluate("Write", { file_path: join(symlink, "newdir", "evil.ts") });
      expect(r.action).toBe("deny");
      expect(r.strikes).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("resolves symlink in worktreeRoot itself", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
    const realWorktree = join(base, "real-worktree");
    const symlinkWorktree = join(base, "link-worktree");
    mkdirSync(realWorktree, { recursive: true });
    symlinkSync(realWorktree, symlinkWorktree);

    try {
      // Guard constructed with symlink path should still allow writes inside
      const g = new ContainmentGuard(symlinkWorktree);
      const r = g.evaluate("Write", { file_path: join(realWorktree, "ok.ts") });
      expect(r.action).toBe("allow");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("denies symlink escape when resolved and unresolved roots diverge (platform-independent)", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
    const realRoot = join(base, "real-root");
    const aliasRoot = join(base, "alias-root");
    const outside = join(base, "outside");
    mkdirSync(realRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // alias-root → real-root: guarantees worktreeRoot (resolved) ≠ _unresolvedRoot
    symlinkSync(realRoot, aliasRoot);

    const worktree = join(aliasRoot, "worktree");
    mkdirSync(worktree, { recursive: true });
    const outsideDir = join(realRoot, "sibling");
    mkdirSync(outsideDir, { recursive: true });
    // worktree/escape → sibling dir (outside worktree but under same ancestor)
    symlinkSync(outsideDir, join(worktree, "escape"));

    try {
      // Construct guard with the ALIASED path — unresolvedRoot = .../alias-root/worktree,
      // worktreeRoot = .../real-root/worktree (resolved). Incoming file_path uses the
      // alias form, so without the unresolvedRoot check the startsWith guard misses.
      const g = new ContainmentGuard(join(aliasRoot, "worktree"));
      const escapePath = join(aliasRoot, "worktree", "escape", "evil.ts");
      const r = g.evaluate("Write", { file_path: escapePath });
      expect(r.action).toBe("deny");
      expect(r.strikes).toBe(1);

      // Edit via same escape path
      const r2 = g.evaluate("Edit", { file_path: escapePath });
      expect(r2.action).toBe("deny");

      // Bash write via same escape path
      const g2 = new ContainmentGuard(join(aliasRoot, "worktree"));
      const r3 = g2.evaluate("Bash", { command: `tee ${escapePath}` });
      expect(r3.action).toBe("deny");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("denies Write to /tmp symlink pointing outside allowed prefixes", () => {
    // Nominal path starts with /tmp/ so old resolve()-based check would allow it,
    // but real target is outside any allowed prefix. We use homedir() instead of
    // process.cwd() because the latter may be under /private/tmp (e.g. in a QA worktree),
    // which would cause resolveRealpath to return a path that passes the prefix check.
    const linkPath = join("/tmp", `mcp-containment-test-${process.pid}`);
    rmSync(linkPath, { force: true }); // guard against EEXIST from a crashed prior run
    symlinkSync(homedir(), linkPath);
    try {
      const g = new ContainmentGuard("/unrelated/worktree");
      const r = g.evaluate("Write", { file_path: join(linkPath, "evil.ts") });
      expect(r.action).toBe("deny");
    } finally {
      rmSync(linkPath, { force: true });
    }
  });
});

// ── Relative path resolution — uses session cwd, not daemon cwd ──

describe("ContainmentGuard — relative path resolution", () => {
  test("relative traversal in Write resolves against worktree root, not daemon cwd", () => {
    const g = guard();
    const r = g.evaluate("Write", { file_path: "../../../etc/passwd" });
    expect(r.action).toBe("deny");
    expect(r.reason).toContain(resolve(WORKTREE, "../../../etc/passwd"));
  });

  test("relative path inside worktree resolves correctly", () => {
    const g = guard();
    // ./src/main.ts resolves to WORKTREE/src/main.ts — allowed
    const r = g.evaluate("Write", { file_path: "./src/main.ts" });
    expect(r.action).toBe("allow");
  });

  test("relative traversal in Read resolves against worktree root", () => {
    const g = guard();
    const r = g.evaluate("Read", { file_path: "../../../../etc/hosts" });
    expect(r.action).toBe("warn");
    expect(r.reason).toContain(resolve(WORKTREE, "../../../../etc/hosts"));
  });

  test("relative traversal in Edit resolves against worktree root", () => {
    const g = guard();
    const r = g.evaluate("Edit", { file_path: "../../evil.ts", old_string: "a", new_string: "b" });
    expect(r.action).toBe("deny");
  });

  test("relative path to /tmp resolves correctly and is allowed for writes", () => {
    // A relative path that happens to land in /tmp after resolution is allowed
    const g = new ContainmentGuard("/tmp/worktree");
    const r = g.evaluate("Write", { file_path: "./output.txt" });
    expect(r.action).toBe("allow");
  });
});
