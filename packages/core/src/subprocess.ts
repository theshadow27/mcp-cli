export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SIGKILL_GRACE_MS = 5_000;

export async function spawnCapture(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string },
): Promise<SpawnResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      stdin: opts?.input != null ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { ok: false, exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false };
  }

  if (opts?.input != null && proc.stdin && typeof proc.stdin !== "number") {
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(opts.input);
    sink.end();
  }

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let termTimer: ReturnType<typeof setTimeout> | undefined;

  if (opts?.timeoutMs != null) {
    termTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_GRACE_MS);
    }, opts.timeoutMs);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);

  await proc.exited;

  if (termTimer) clearTimeout(termTimer);
  if (killTimer) clearTimeout(killTimer);

  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode ?? null,
    signal: proc.signalCode ?? null,
    stdout,
    stderr,
    timedOut,
  };
}

export function spawnCaptureSync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): SpawnResult {
  const start = performance.now();
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([cmd, ...args], {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts?.timeoutMs,
    });
  } catch {
    return { ok: false, exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false };
  }

  const elapsed = performance.now() - start;
  const hitTimeout = opts?.timeoutMs != null && !result.success && elapsed >= opts.timeoutMs - 50;

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    signal: result.signalCode ?? null,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    timedOut: hitTimeout,
  };
}
