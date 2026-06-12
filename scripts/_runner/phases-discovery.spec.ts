import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";

// Nested bun cold start can stretch under CI parallel load; the phase suite
// itself runs in ~20ms.
setDefaultTimeout(15_000);

// Real-bun smoke test for the pathIgnorePatterns bypass (#2719).
//
// The phases CI step relies on a fragile, otherwise-untested invariant: the
// root bunfig.toml sets `pathIgnorePatterns = [".claude/**"]`, which bun
// anchors to the bunfig's directory — so specs discovered relative to a
// `.claude/phases/` cwd happen NOT to match the root-anchored glob and run.
// If a bun upgrade changes that anchoring, `bun test` from that cwd discovers
// 0 files and exits 0, silently reverting phase specs to the pre-#2648 dark
// state. This test spawns the REAL bun (no fake-bun stub) from that cwd and
// asserts the discovered count covers every spec file on disk.

const repoRoot = resolve(import.meta.dir, "../..");
const phasesDir = join(repoRoot, ".claude", "phases");

describe("phases spec discovery (real bun, #2719)", () => {
  it("bun test from .claude/phases discovers every on-disk spec file", () => {
    let specCount = 0;
    for (const _ of new Glob("**/*.spec.ts").scanSync({ cwd: phasesDir })) specCount++;
    expect(specCount).toBeGreaterThanOrEqual(1);

    const junitPath = join(mkdtempSync(join(tmpdir(), "phases-discovery-")), "junit.xml");
    const run = spawnSync(
      process.execPath,
      ["test", "--no-orphans", "--reporter", "junit", `--reporter-outfile=${junitPath}`],
      { cwd: phasesDir, encoding: "utf8" },
    );
    expect(run.status).toBe(0);

    const xml = readFileSync(junitPath, "utf8");
    const m = xml.match(/tests="(\d+)"/);
    expect(m).not.toBeNull();
    const discoveredTests = Number.parseInt((m as RegExpMatchArray)[1], 10);
    // Each spec file contributes at least one test, so tests >= files. A
    // 0-discovery regression reports tests="0" (or no junit at all) here
    // instead of exiting 0 unnoticed.
    expect(discoveredTests).toBeGreaterThanOrEqual(specCount);

    const summary = `${run.stdout}${run.stderr}`;
    const files = summary.match(/^Ran \d+ tests? across (\d+) files?/m);
    expect(files).not.toBeNull();
    expect(Number.parseInt((files as RegExpMatchArray)[1], 10)).toBeGreaterThanOrEqual(specCount);
  });
});
