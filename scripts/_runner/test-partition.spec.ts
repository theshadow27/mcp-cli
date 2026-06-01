import { describe, expect, it } from "bun:test";
import { globSync } from "node:fs";
import { resolve } from "node:path";

import { DAEMON_TEST_PATHS, NON_DAEMON_TEST_PATHS } from "../am-i-done";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function allSpecFiles(): string[] {
  return globSync("**/*.spec.ts", {
    cwd: REPO_ROOT,
    ignore: ["node_modules/**", "**/node_modules/**"],
  });
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
