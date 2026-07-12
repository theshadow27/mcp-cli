import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { DAEMON_TEST_PATHS, NON_DAEMON_TEST_PATHS, parseFlag, parseRepeatableFlag } from "../am-i-done";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// Enumerate tracked spec files via `git ls-files` rather than a filesystem glob so
// untracked/gitignored scratch specs (e.g. under build/) never enter the partition check (#2850).
// Dot-directory specs (.claude/**, .git-hooks/**) are excluded to match the prior glob semantics:
// they are run by dedicated CI steps (test:phases, test:hooks), not the two partitions checked here.
function allSpecFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "*.spec.ts"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((f) => !f.split("/").some((seg) => seg.startsWith(".")));
}

function matchesPath(file: string, paths: string[]): boolean {
  return paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
}

describe("CI test path partition", () => {
  const ALL_CI_PATHS = [...NON_DAEMON_TEST_PATHS, ...DAEMON_TEST_PATHS];

  it("non-daemon and daemon paths are mutually exclusive", () => {
    const overlap = NON_DAEMON_TEST_PATHS.filter((p) =>
      DAEMON_TEST_PATHS.some((d) => p.startsWith(d) || d.startsWith(p)),
    );
    expect(overlap).toEqual([]);
  });

  it("every *.spec.ts in the repo is covered by exactly one partition", () => {
    const specs = allSpecFiles();
    const uncovered = specs.filter((f) => !matchesPath(f, ALL_CI_PATHS));
    expect(uncovered).toEqual([]);
  });

  it("scripts/ root-level spec files are covered (regression guard for #2613)", () => {
    const scriptsRootSpecs = allSpecFiles().filter(
      (f) => f.startsWith("scripts/") && !f.startsWith("scripts/_runner/") && !f.startsWith("scripts/rules/"),
    );
    expect(scriptsRootSpecs.length).toBeGreaterThan(0);
    const uncovered = scriptsRootSpecs.filter((f) => !matchesPath(f, ALL_CI_PATHS));
    expect(uncovered).toEqual([]);
  });

  it("a hypothetical scripts/newdir/foo.spec.ts would be matched", () => {
    const hypothetical = "scripts/newdir/foo.spec.ts";
    expect(matchesPath(hypothetical, ALL_CI_PATHS)).toBe(true);
  });
});

describe("parseFlag", () => {
  it("returns the value after a matching flag", () => {
    expect(parseFlag(["--from", "3", "--verbose"], "--from")).toBe("3");
  });

  it("returns undefined when flag is absent", () => {
    expect(parseFlag(["--verbose"], "--from")).toBeUndefined();
  });

  it("returns undefined when flag is last with no value", () => {
    expect(parseFlag(["--from"], "--from")).toBeUndefined();
  });
});

describe("parseRepeatableFlag", () => {
  it("collects all values for a repeated flag", () => {
    expect(parseRepeatableFlag(["--skip", "lint", "--skip", "coverage"], "--skip")).toEqual(["lint", "coverage"]);
  });

  it("returns empty array when flag is absent", () => {
    expect(parseRepeatableFlag(["--verbose"], "--skip")).toEqual([]);
  });

  it("skips a trailing flag with no value", () => {
    expect(parseRepeatableFlag(["--skip", "lint", "--skip"], "--skip")).toEqual(["lint"]);
  });
});
