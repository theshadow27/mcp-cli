export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// spawnManaged — long-lived process helper
// ---------------------------------------------------------------------------

export interface ManagedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "pipe" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
  /** Real-time tap on decoded stderr chunks (only when stderr is "pipe"). */
  onStderr?: (chunk: string) => void;
  /** Maximum bytes retained in the stderr ring buffer (default 64 KB). */
  stderrMaxBytes?: number;
  /** SIGTERM → SIGKILL grace window in ms (default 5 000). */
  killGraceMs?: number;
}

export interface ManagedExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface ManagedHandle {
  readonly pid: number;
  readonly stdin: import("bun").FileSink | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  /** Resolves when the process exits. */
  readonly exited: Promise<ManagedExitStatus>;
  /** SIGTERM immediately; SIGKILL after graceMs (default from spawn opts). Returns exit status. */
  kill(graceMs?: number): Promise<ManagedExitStatus>;
  /** Detach the child so the parent can exit without waiting. */
  unref(): void;
  /** Return the last N bytes captured from the auto-drained stderr ring buffer. */
  stderrTail(): string;
}

export type ManagedSpawnResult = { ok: true; handle: ManagedHandle } | { ok: false };

const DEFAULT_STDERR_MAX_BYTES = 64 * 1024; // 64 KB

export function spawnManaged(cmd: string, args: string[], opts?: ManagedSpawnOptions): ManagedSpawnResult {
  const stderrMode = opts?.stderr ?? "pipe";
  const stdoutMode = opts?.stdout ?? "pipe";
  const stdinMode = opts?.stdin ?? "pipe";
  const graceMs = opts?.killGraceMs ?? SIGKILL_GRACE_MS;
  const maxStderr = opts?.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      env: opts?.env,
      stdin: stdinMode,
      stdout: stdoutMode === "ignore" ? "ignore" : stdoutMode === "inherit" ? "inherit" : "pipe",
      stderr: stderrMode === "ignore" ? "ignore" : stderrMode === "inherit" ? "inherit" : "pipe",
    });
  } catch {
    return { ok: false };
  }

  // --- stderr auto-drain ring buffer ---
  let stderrBuf = "";
  if (stderrMode === "pipe" && proc.stderr && typeof proc.stderr !== "number") {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const onChunk = opts?.onStderr;
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          onChunk?.(text);
          stderrBuf += text;
          if (stderrBuf.length > maxStderr) {
            stderrBuf = stderrBuf.slice(-maxStderr);
          }
        }
        stderrBuf += decoder.decode(); // flush
      } catch {
        // stream closed — expected on kill
      }
    })();
  }

  // --- exited promise with honest reporting ---
  const exitedPromise: Promise<ManagedExitStatus> = proc.exited.then(() => ({
    exitCode: proc.exitCode ?? null,
    signal: proc.signalCode ?? null,
  }));

  // --- kill with SIGTERM→SIGKILL escalation ---
  // Clear the SIGKILL timer on exit so a SIGTERM-cooperator doesn't leak a
  // graceMs-pending timer into the event loop AND doesn't fire SIGKILL at a
  // recycled PID. exitedPromise.finally is a microtask, so even if exited
  // already resolved before kill() set the timer, the cleanup wins the race.
  let killed = false;
  const kill = (overrideGraceMs?: number): Promise<ManagedExitStatus> => {
    if (killed) return exitedPromise;
    killed = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    const g = overrideGraceMs ?? graceMs;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, g);
    exitedPromise.finally(() => clearTimeout(timer));
    return exitedPromise;
  };

  const stdinSink: import("bun").FileSink | null =
    stdinMode === "pipe" && proc.stdin && typeof proc.stdin !== "number"
      ? (proc.stdin as import("bun").FileSink)
      : null;

  const stdoutStream: ReadableStream<Uint8Array> | null =
    stdoutMode === "pipe" && proc.stdout && typeof proc.stdout !== "number"
      ? (proc.stdout as ReadableStream<Uint8Array>)
      : null;

  const handle: ManagedHandle = {
    pid: proc.pid,
    stdin: stdinSink,
    stdout: stdoutStream,
    exited: exitedPromise,
    kill,
    unref: () => proc.unref(),
    stderrTail: () => stderrBuf,
  };

  return { ok: true, handle };
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
      if (!truncated) {
        if (total + value.byteLength > maxBytes) {
          parts.push(value.subarray(0, maxBytes - total));
          total = maxBytes;
          truncated = true;
        } else {
          parts.push(value);
          total += value.byteLength;
        }
      }
      // After truncation keep reading (discarding) so the child doesn't
      // block on a full pipe and hang; reader.cancel() cleans up on exit.
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(parts).toString("utf8"), truncated };
}

/**
 * `env` is passed through to Bun.spawn unchanged: when provided, it REPLACES
 * the child's environment (Bun's native semantics); when undefined, the child
 * inherits process.env. Callers that want to inherit-and-add must merge
 * themselves (e.g. `{ ...process.env, EXTRA: "1" }`); callers that need a
 * *cleaned* env (stripping GIT_DIR etc. from a git hook context) pass the
 * already-cleaned dict. Merging here would silently re-add stripped vars.
 */
export async function spawnCapture(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      env: opts?.env,
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

/** Synchronous variant of {@link spawnCapture}; identical `env` semantics (pass-through, not merged). */
export function spawnCaptureSync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; input?: string },
): SpawnResult {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([cmd, ...args], {
      cwd: opts?.cwd,
      env: opts?.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts?.input != null ? Buffer.from(opts.input) : undefined,
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
