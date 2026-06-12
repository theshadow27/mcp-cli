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

  // Bun's default outbase shifts with the entrypoint count (1.3.14: ≤8 embeds
  // workers flat at /$bunfs/root/, ≥9 nests them under packages/daemon/src/),
  // which breaks compiled-mode `./<name>.ts` worker resolution for ALL workers
  // at once while the build still exits 0. Every daemon compile command must
  // pin the outbase with --root so the layout is deterministic; build.ts also
  // smoke-boots the compiled binary to verify it (smokeDaemonWorkers).
  it("build.ts pins --root on every compile command that embeds the workers", () => {
    const buildSrc = readFileSync(resolve("scripts/build.ts"), "utf-8");
    const compileLines = buildSrc.split("\n").filter((l) => l.includes("${daemonWorkers}"));
    expect(compileLines.length).toBeGreaterThan(0);
    for (const line of compileLines) {
      expect(line).toContain("--root=${workerRoot}");
    }
  });
});
