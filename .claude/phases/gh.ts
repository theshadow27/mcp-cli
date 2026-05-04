/**
 * Async GitHub CLI helper for phase scripts.
 *
 * Replaces blocking Bun.spawnSync('gh', ...) with async Bun.spawn.
 * Timeout with SIGTERM → SIGKILL escalation.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SIGKILL_DELAY_MS = 5_000;

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A function with the same signature as the top-level `gh()` — injectable for tests. */
export type GhRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<GhResult>;

export async function gh(
  args: string[],
  opts?: { timeoutMs?: number; sigkillDelayMs?: number },
): Promise<GhResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sigkillDelayMs = opts?.sigkillDelayMs ?? DEFAULT_SIGKILL_DELAY_MS;
  return runGh(args, timeoutMs, sigkillDelayMs);
}

async function runGh(args: string[], timeoutMs: number, sigkillDelayMs: number): Promise<GhResult> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    proc.kill();
    sigkillTimer = setTimeout(() => {
      try { proc.kill(9); } catch { /* already exited */ }
    }, sigkillDelayMs);
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);
  if (sigkillTimer) clearTimeout(sigkillTimer);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function prView(
  prNumber: number,
  fields: string,
  jqExpr?: string,
  _gh: GhRunner = gh,
): Promise<string> {
  const args = ["pr", "view", String(prNumber), "--json", fields];
  if (jqExpr) args.push("-q", jqExpr);
  const result = await _gh(args);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr view ${prNumber} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

export async function prList(
  opts: { head?: string; json?: string; jq?: string },
  _gh: GhRunner = gh,
): Promise<string> {
  const args = ["pr", "list"];
  if (opts.head) args.push("--head", opts.head);
  if (opts.json) args.push("--json", opts.json);
  if (opts.jq) args.push("-q", opts.jq);
  const result = await _gh(args);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

export async function prEdit(
  prNumber: number,
  flags: string[],
  _gh: GhRunner = gh,
): Promise<void> {
  const result = await _gh(["pr", "edit", String(prNumber), ...flags]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr edit ${prNumber} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

export async function prMerge(
  prNumber: number,
  flags: string[],
  _gh: GhRunner = gh,
): Promise<GhResult> {
  return _gh(["pr", "merge", String(prNumber), ...flags]);
}

export async function prComment(
  prNumber: number,
  body: string,
  _gh: GhRunner = gh,
): Promise<void> {
  const result = await _gh(["pr", "comment", String(prNumber), "--body", body]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr comment ${prNumber} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

export async function spawn(
  cmd: string[],
  opts?: { timeoutMs?: number; sigkillDelayMs?: number },
): Promise<GhResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sigkillDelayMs = opts?.sigkillDelayMs ?? DEFAULT_SIGKILL_DELAY_MS;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    proc.kill();
    sigkillTimer = setTimeout(() => {
      try { proc.kill(9); } catch { /* already exited */ }
    }, sigkillDelayMs);
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (sigkillTimer) clearTimeout(sigkillTimer);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
