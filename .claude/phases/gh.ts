/**
 * Async GitHub CLI helper for phase scripts.
 *
 * Replaces blocking Bun.spawnSync('gh', ...) with async Bun.spawn.
 * In-process request deduplication: concurrent identical read calls share
 * one subprocess. Mutations skip dedup.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const inflight = new Map<string, Promise<GhResult>>();

export async function gh(
  args: string[],
  opts?: { timeoutMs?: number; skipDedup?: boolean },
): Promise<GhResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skipDedup = opts?.skipDedup ?? false;

  const key = args.join("\0");
  if (!skipDedup) {
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const promise = runGh(args, timeoutMs);

  if (!skipDedup) {
    inflight.set(key, promise);
    promise.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
  }

  return promise;
}

async function runGh(args: string[], timeoutMs: number): Promise<GhResult> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function prView(prNumber: number, fields: string, jqExpr?: string): Promise<string> {
  const args = ["pr", "view", String(prNumber), "--json", fields];
  if (jqExpr) args.push("-q", jqExpr);
  const result = await gh(args);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr view ${prNumber} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

export async function prList(opts: { head?: string; json?: string; jq?: string }): Promise<string> {
  const args = ["pr", "list"];
  if (opts.head) args.push("--head", opts.head);
  if (opts.json) args.push("--json", opts.json);
  if (opts.jq) args.push("-q", opts.jq);
  const result = await gh(args);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

export async function prEdit(prNumber: number, flags: string[]): Promise<void> {
  await gh(["pr", "edit", String(prNumber), ...flags], { skipDedup: true });
}

export async function prMerge(prNumber: number, flags: string[]): Promise<GhResult> {
  return gh(["pr", "merge", String(prNumber), ...flags], { skipDedup: true });
}

export async function prComment(prNumber: number, body: string): Promise<boolean> {
  const result = await gh(["pr", "comment", String(prNumber), "--body", body], { skipDedup: true });
  return result.exitCode === 0;
}

export function _inflightSize(): number {
  return inflight.size;
}

export async function spawn(cmd: string[], opts?: { timeoutMs?: number }): Promise<GhResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
