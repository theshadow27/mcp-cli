/**
 * Cross-platform advisory file locking via flock(2).
 *
 * Uses bun:ffi to call the kernel's flock() syscall directly.
 * The lock is kernel-managed: released automatically on process death (even SIGKILL),
 * fd close, or explicit unlock. No stale lock files.
 *
 * macOS: libSystem.B.dylib
 * Linux: libc.so.6
 */

import { FFIType, dlopen } from "bun:ffi";

const LOCK_EX = 2; // Exclusive lock
const LOCK_NB = 4; // Non-blocking
const LOCK_UN = 8; // Unlock

interface FlockLib {
  flock(fd: number, operation: number): number;
  close(): void;
}

let lib: FlockLib | null = null;

function getLib(): FlockLib {
  if (lib) return lib;
  const libPath = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  const handle = dlopen(libPath, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  lib = {
    flock: (fd, op) => handle.symbols.flock(fd, op) as number,
    close: () => handle.close(),
  };
  return lib;
}

/**
 * Try to acquire an exclusive, non-blocking advisory lock on a file descriptor.
 * Returns true if the lock was acquired, false if another process holds it.
 * Throws on unexpected errors.
 */
export function tryFlockExclusive(fd: number): boolean {
  const result = getLib().flock(fd, LOCK_EX | LOCK_NB);
  if (result === 0) return true;
  // EWOULDBLOCK (EAGAIN on Linux, same value) means another process holds the lock
  return false;
}

/**
 * Release an advisory lock on a file descriptor.
 */
export function flockUnlock(fd: number): void {
  getLib().flock(fd, LOCK_UN);
}
