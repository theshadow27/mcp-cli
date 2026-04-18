import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SPRINT_ACTIVE_SH = resolve(import.meta.dir, "sprint-active.sh");

type RunResult = { code: number; stdout: string; stderr: string };

async function runCheck(cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  const script = `
    set -u
    source "${SPRINT_ACTIVE_SH}"
    if sprint_active_check; then
      echo "ALLOW"
      exit 0
    else
      echo "BLOCK"
      exit 1
    fi
  `;
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function sh(cwd: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} (cwd=${cwd}) exited ${code}: ${err}`);
  }
}

describe("sprint_active_check", () => {
  let root: string;
  let main: string;
  let worktree: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sprint-active-"));
    main = join(root, "main");
    worktree = join(root, "wt");
    mkdirSync(main, { recursive: true });
    await sh(main, ["git", "init", "-q", "-b", "main"]);
    await sh(main, ["git", "config", "user.email", "t@example.com"]);
    await sh(main, ["git", "config", "user.name", "Test"]);
    await sh(main, ["git", "config", "commit.gpgsign", "false"]);
    writeFileSync(join(main, "README.md"), "init\n");
    await sh(main, ["git", "add", "README.md"]);
    await sh(main, ["git", "commit", "-qm", "init"]);
    await sh(main, ["git", "worktree", "add", "-q", worktree, "-b", "feature"]);
    mkdirSync(join(main, ".claude", "sprints"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("allows commit on main when no sentinel exists", async () => {
    const result = await runCheck(main);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ALLOW");
  });

  test("blocks commit on main when sentinel exists", async () => {
    writeFileSync(join(main, ".claude", "sprints", ".active"), "37\n");
    const result = await runCheck(main);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("BLOCK");
    expect(result.stderr).toContain("sprint 37 is active");
    expect(result.stderr).toContain("SPRINT_OVERRIDE=1");
  });

  test("allows commit on main when sentinel exists but SPRINT_OVERRIDE is set", async () => {
    writeFileSync(join(main, ".claude", "sprints", ".active"), "37\n");
    const result = await runCheck(main, { SPRINT_OVERRIDE: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ALLOW");
    expect(result.stderr).toContain("SPRINT_OVERRIDE=1");
  });

  test("allows commit in worktree even when sentinel exists", async () => {
    writeFileSync(join(main, ".claude", "sprints", ".active"), "37\n");
    const result = await runCheck(worktree);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ALLOW");
  });

  test("allows commit in worktree when sentinel does not exist", async () => {
    const result = await runCheck(worktree);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ALLOW");
  });

  test("handles empty sentinel file gracefully", async () => {
    writeFileSync(join(main, ".claude", "sprints", ".active"), "");
    const result = await runCheck(main);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sprint ? is active");
  });

  test("no-ops outside a git repo", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "non-repo-"));
    try {
      const result = await runCheck(nonRepo);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("ALLOW");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
