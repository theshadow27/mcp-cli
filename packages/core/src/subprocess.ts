export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

const SIGKILL_GRACE_MS = 5_000;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

async function drainStream(stream: ReadableStream, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        parts.push(value.subarray(0, maxBytes - total));
        truncated = true;
        break;
      }
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(parts).toString("utf8"), truncated };
}

export async function spawnCapture(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number },
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
    return { ok: false, exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
  }

  if (opts?.input != null && proc.stdin && typeof proc.stdin !== "number") {
    try {
      const sink = proc.stdin as import("bun").FileSink;
      sink.write(opts.input);
      await sink.end();
    } catch {
      // EPIPE: child closed stdin early; continue draining output
    }
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

  const maxBytes = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const [out, err] = await Promise.all([
    drainStream(proc.stdout as ReadableStream, maxBytes),
    drainStream(proc.stderr as ReadableStream, maxBytes),
  ]);

  await proc.exited;

  if (termTimer) clearTimeout(termTimer);
  if (killTimer) clearTimeout(killTimer);

  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode ?? null,
    signal: proc.signalCode ?? null,
    stdout: out.text,
    stderr: err.text,
    timedOut,
    truncated: out.truncated || err.truncated,
  };
}

export function spawnCaptureSync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; maxBuffer?: number },
): SpawnResult {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([cmd, ...args], {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts?.timeoutMs,
    });
  } catch {
    return { ok: false, exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
  }

  // Bun sends SIGTERM when the timeout elapses; elapsed-time heuristics are unreliable
  const hitTimeout = opts?.timeoutMs != null && result.signalCode === "SIGTERM";

  const maxBytes = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const stdoutBuf = result.stdout;
  const stderrBuf = result.stderr;
  const stdoutTrunc = stdoutBuf != null && stdoutBuf.byteLength > maxBytes;
  const stderrTrunc = stderrBuf != null && stderrBuf.byteLength > maxBytes;

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    signal: result.signalCode ?? null,
    stdout: stdoutTrunc ? (stdoutBuf?.slice(0, maxBytes).toString() ?? "") : (stdoutBuf?.toString() ?? ""),
    stderr: stderrTrunc ? (stderrBuf?.slice(0, maxBytes).toString() ?? "") : (stderrBuf?.toString() ?? ""),
    timedOut: hitTimeout,
    truncated: stdoutTrunc || stderrTrunc,
  };
}
