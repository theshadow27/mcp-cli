/**
 * Resolve worker file paths for both dev mode and compiled binaries.
 *
 * In dev mode, workers are resolved via absolute paths using import.meta.dir.
 *
 * In compiled binaries (`bun build --compile`), workers are embedded as
 * additional entrypoint modules. Reconstructing a single predicted embed path
 * has broken worker resolution three times (#2721→#2762→#2796) because Bun's
 * outbase layout is count-dependent (≤8 entrypoints embed flat at
 * `/$bunfs/root/<name>.js`, ≥9 nest under `packages/daemon/src/<name>.js`).
 *
 * `Bun.embeddedFiles` lists embedded *assets*, not entrypoint modules (verified
 * empty for workers), so it can't be indexed. Instead we probe the actual
 * embedded module graph with `Bun.resolveSync` against every known layout and
 * use whichever one the binary really has. This tolerates a layout shift at
 * runtime instead of predicting a single one, closing the ModuleNotFound class
 * regardless of which outbase Bun picks (#2801).
 *
 * Build injects `__COMPILED__ = true` via --define; defaults to false at runtime.
 */

import { basename, join } from "node:path";

declare const __COMPILED__: boolean;
const isCompiled = typeof __COMPILED__ !== "undefined" && __COMPILED__;

/** Directory containing worker source files (dev mode only). */
const WORKER_DIR = import.meta.dir;

/** Extension-less basename, so a `.ts` reference matches an embedded `.js`. */
function stem(name: string): string {
  return basename(name).replace(/\.[cm]?[jt]s$/, "");
}

/** Candidate embedded specifiers for a worker, one per known Bun outbase layout. */
function embedCandidates(name: string): string[] {
  return [
    `./${name}.js`, // flat layout (≤8 entrypoints / pinned --root)
    `./packages/daemon/src/${name}.js`, // nested layout (≥9 entrypoints, #2796)
  ];
}

/**
 * Resolve a compiled-mode worker by probing the embedded module graph rather
 * than reconstructing one predicted path. `resolve` is injected for tests;
 * production passes `Bun.resolveSync`.
 */
export function resolveEmbeddedWorker(
  filename: string,
  resolve: (specifier: string) => string = (s) => Bun.resolveSync(s, WORKER_DIR),
): string {
  const candidates = embedCandidates(stem(filename));
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = resolve(candidate);
    } catch {
      continue; // this layout isn't present in the binary — try the next
    }
    // Only an embedded module counts; a bare `.js` can otherwise resolve to a
    // stray file on the real filesystem.
    if (resolved.startsWith("/$bunfs/")) return resolved;
  }
  throw new Error(
    `Worker not embedded: ${filename}. Tried ${candidates.join(", ")}. ` +
      `Add packages/daemon/src/${filename} to scripts/daemon-workers.ts.`,
  );
}

/** Resolve a worker filename to a path usable with `new Worker()`. */
export function workerPath(filename: string): string {
  if (!isCompiled) return join(WORKER_DIR, filename);
  return resolveEmbeddedWorker(filename);
}
