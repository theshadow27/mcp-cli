/**
 * Resolve worker file paths for both dev mode and compiled binaries.
 *
 * In compiled binaries (`bun build --compile`), workers are embedded as
 * additional entrypoints and resolved via relative string paths.
 * In dev mode, workers are resolved via absolute paths using import.meta.dir.
 *
 * Build injects `__COMPILED__ = true` via --define; defaults to false at runtime.
 */

import { join } from "node:path";

declare const __COMPILED__: boolean;
const isCompiled = typeof __COMPILED__ !== "undefined" && __COMPILED__;

/** Directory containing worker source files (dev mode only). */
const WORKER_DIR = import.meta.dir;

/** Resolve a worker filename to a path usable with `new Worker()`. */
export function workerPath(filename: string): string {
  return isCompiled ? `./${filename}` : join(WORKER_DIR, filename);
}
