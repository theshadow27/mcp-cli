// Guards the compiled-binary worker bundle: every worker the daemon loads via
// `workerPath("...")` / `workerScript: "..."` must be an explicit entrypoint in
// `daemonWorkers`, or the compiled `dist/mcpd` fails at runtime with
// `ModuleNotFound resolving "./<name>" (entry point)` (issue #2721 — ACP).
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Glob } from "bun";
import { daemonWorkers } from "./daemon-workers";

const DAEMON_SRC = resolve("packages/daemon/src");

/** Worker filenames (e.g. "acp-session-worker.ts") referenced from daemon source. */
function referencedWorkers(): Set<string> {
  const refs = new Set<string>();
  const literal = /(?:workerPath\(\s*|workerScript:\s*)"([^"]+\.ts)"/g;
  for (const file of new Glob("**/*.ts").scanSync({ cwd: DAEMON_SRC, absolute: true })) {
    if (file.endsWith(".spec.ts")) continue;
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(literal)) refs.add(m[1]);
  }
  return refs;
}

const bundledNames = new Set(daemonWorkers.map((p) => basename(p)));

describe("daemonWorkers bundle list", () => {
  it("includes every worker referenced from daemon source", () => {
    const missing = [...referencedWorkers()].filter((w) => !bundledNames.has(w)).sort();
    expect(missing).toEqual([]);
  });

  it("lists only files that exist", () => {
    const absent = daemonWorkers.filter((p) => !existsSync(resolve(p)));
    expect(absent).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(daemonWorkers.length).toBe(new Set(daemonWorkers).size);
  });

  // The former "build.ts pins --root" string-match assertion lived here. It
  // tested implementation spelling, not behavior — it false-failed on harmless
  // build.ts refactors and would green-pass if a Bun upgrade broke resolution
  // at a different layer. Worker resolution now probes the actual embedded
  // module graph across every known layout via Bun.resolveSync (worker-path.ts,
  // #2801), so a single predicted layout is no longer load-bearing; the
  // post-compile boot smoke in build.ts is the behavior-true guard that every
  // worker actually starts.
});
