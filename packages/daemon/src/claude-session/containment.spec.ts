import { describe, expect, test } from "bun:test";
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

  test("allows unknown tools (no file_path)", () => {
    const g = guard();
    const r = g.evaluate("Agent", { prompt: "do something" });
    expect(r.action).toBe("allow");
  });
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

  test("handles missing file_path in Write", () => {
    const g = guard();
    const r = g.evaluate("Write", {});
    expect(r.action).toBe("allow");
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

// ── Relative path resolution — uses session cwd, not daemon cwd ──

describe("ContainmentGuard — relative path resolution", () => {
  test("relative traversal in Write resolves against worktree root, not daemon cwd", () => {
    const g = guard();
    // ../../.. from WORKTREE lands at /Users, which is outside the worktree
    const r = g.evaluate("Write", { file_path: "../../../etc/passwd" });
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("/etc/passwd");
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
    expect(r.reason).toContain("/etc/hosts");
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
