/**
 * Cross-platform advisory file locking via flock(2).
 *
 * Uses bun:ffi to call the kernel's flock() syscall directly.
 * The lock is kernel-managed: released automatically on process death (even SIGKILL),
 * fd close, or explicit unlock. No stale lock files.
 *
 * macOS: libSystem.B.dylib
 * Linux: libc.so.6 (glibc) or the process's own libc (musl/Alpine)
 *
 * Note: flock(2) uses advisory locks which may behave differently over NFS
 * (emulated via fcntl byte-range locks, kernel/mount-option dependent).
 */

import { FFIType, type Pointer, dlopen, read } from "bun:ffi";

const LOCK_EX = 2; // Exclusive lock
const LOCK_NB = 4; // Non-blocking
const LOCK_UN = 8; // Unlock

// EWOULDBLOCK errno value per platform (EAGAIN on Linux has the same value)
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

interface FlockLib {
  flock(fd: number, operation: number): number;
  getErrno(): number;
  close(): void;
}

let lib: FlockLib | null = null;

/** @internal Exported for testing. Probes libc paths for musl/glibc compatibility. */
export function resolveLinuxLibPath(): string {
  // Try glibc first, then common musl paths
  for (const candidate of ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"]) {
    try {
      const probe = dlopen(candidate, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      probe.close();
      return candidate;
    } catch {
      // try next
    }
  }
  return "libc.so.6"; // fallback — will produce a clear error at call time
}

function getLib(): FlockLib {
  if (lib) return lib;
  const isMac = process.platform === "darwin";
  const libPath = isMac ? "libSystem.B.dylib" : resolveLinuxLibPath();
  const errnoFnName = isMac ? "__error" : "__errno_location";

  const handle = dlopen(libPath, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoFnName]: { args: [], returns: FFIType.ptr },
  });
  lib = {
    flock: (fd, op) => handle.symbols.flock(fd, op) as number,
    getErrno: () => {
      const errPtr = handle.symbols[errnoFnName]() as Pointer;
      return read.i32(errPtr, 0);
    },
    close: () => handle.close(),
  };
  return lib;
}

/**
 * Try to acquire an exclusive, non-blocking advisory lock on a file descriptor.
 * Returns true if the lock was acquired, false if another process holds it (EWOULDBLOCK).
 * Throws on unexpected errors (EINTR, EBADF, ENOLCK, etc.).
 */
export function tryFlockExclusive(fd: number): boolean {
  const ffi = getLib();
  const result = ffi.flock(fd, LOCK_EX | LOCK_NB);
  if (result === 0) return true;
  const errno = ffi.getErrno();
  if (errno === EWOULDBLOCK) return false;
  throw new Error(`flock(2) failed with errno ${errno}`);
}

/**
 * Release an advisory lock on a file descriptor.
 */
export function flockUnlock(fd: number): void {
  getLib().flock(fd, LOCK_UN);
}
