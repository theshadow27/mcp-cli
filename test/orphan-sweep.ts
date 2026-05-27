/**
 * Pre-test orphan sweep — kills leaked test workers and fixture processes
 * that were reparented to init (PPID 1) after their spawner died.
 *
 * Added to bunfig.toml preload so it runs before every test suite.
 */
import { spawnSync } from "node:child_process";

export interface PsEntry {
  pid: number;
  ppid: number;
  command: string;
}

const PS_TIMEOUT_MS = 5_000;

// Patterns are intentionally specific to avoid matching live CI runners.
// /bun\s+test\s+--test-worker\b/ targets only Bun's internal worker spawn,
// not the top-level `bun test` command (which can have PPID=1 in containers).
const ORPHAN_PATTERNS = [
  /bun\s+test\s+--test-worker\b/,
  /echo-server\.ts/,
  /echo-http-server\.ts/,
  /echo-sse-server\.ts/,
  /slow-echo-server\.ts/,
  /http-401-server\.ts/,
];

export function parsePs(stdout: string): PsEntry[] {
  const lines = stdout.split("\n");
  const entries: PsEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return entries;
}

export function findOrphans(entries: PsEntry[], selfPid: number): PsEntry[] {
  return entries.filter((e) => e.ppid === 1 && e.pid !== selfPid && ORPHAN_PATTERNS.some((p) => p.test(e.command)));
}

export function killOrphans(
  orphans: PsEntry[],
  killFn: (pid: number) => void = (pid) => process.kill(pid, "SIGKILL"),
  log: (msg: string) => void = (msg) => process.stderr.write(msg),
): void {
  for (const orphan of orphans) {
    try {
      killFn(orphan.pid);
      log(`[orphan-sweep] killed pid ${orphan.pid}: ${orphan.command}\n`);
    } catch {
      // Already dead or permission denied — either way, move on.
    }
  }
}

function sweep(): void {
  // -A: all processes; -ww: unlimited command width (avoid macOS truncation at terminal width)
  const result = spawnSync("ps", ["-A", "-ww", "-o", "pid,ppid,command"], {
    encoding: "utf-8",
    timeout: PS_TIMEOUT_MS,
  });
  if (result.status !== 0 || !result.stdout) return;
  killOrphans(findOrphans(parsePs(result.stdout), process.pid));
}

sweep();
