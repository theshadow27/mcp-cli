import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectScope } from "./scope";

describe("detectScope", () => {
  let tmp: string;
  let scopesDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "scope-test-"));
    scopesDir = join(tmp, "scopes");
    mkdirSync(scopesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeScope(name: string, root: string): void {
    writeFileSync(join(scopesDir, `${name}.json`), JSON.stringify({ root, created: new Date().toISOString() }));
  }

  test("detects scope from exact root directory", () => {
    const root = join(tmp, "project");
    mkdirSync(root, { recursive: true });
    writeScope("myproject", root);

    const result = detectScope(root, { scopesDir });
    expect(result).toEqual({ name: "myproject", root });
  });

  test("detects scope from subdirectory", () => {
    const root = join(tmp, "project");
    const sub = join(root, "src", "lib");
    mkdirSync(sub, { recursive: true });
    writeScope("myproject", root);

    const result = detectScope(sub, { scopesDir });
    expect(result).toEqual({ name: "myproject", root });
  });

  test("detects scope from worktree under root", () => {
    const root = join(tmp, "project");
    const worktree = join(root, ".claude", "worktrees", "feat-123");
    mkdirSync(worktree, { recursive: true });
    writeScope("myproject", root);

    const result = detectScope(worktree, { scopesDir });
    expect(result).toEqual({ name: "myproject", root });
  });

  test("returns most specific scope when nested", () => {
    const outer = join(tmp, "workspace");
    const inner = join(outer, "packages", "core");
    mkdirSync(inner, { recursive: true });
    writeScope("workspace", outer);
    writeScope("core", inner);

    const result = detectScope(join(inner, "src"), { scopesDir });
    expect(result).toEqual({ name: "core", root: inner });
  });

  test("returns null when unscoped", () => {
    const unrelated = join(tmp, "elsewhere");
    mkdirSync(unrelated, { recursive: true });
    writeScope("myproject", join(tmp, "project"));

    const result = detectScope(unrelated, { scopesDir });
    expect(result).toBeNull();
  });

  test("returns null when scopes directory does not exist", () => {
    const result = detectScope("/tmp", { scopesDir: join(tmp, "nonexistent") });
    expect(result).toBeNull();
  });

  test("skips malformed scope files", () => {
    const root = join(tmp, "project");
    mkdirSync(root, { recursive: true });
    writeScope("good", root);
    writeFileSync(join(scopesDir, "bad.json"), "not json");

    const result = detectScope(root, { scopesDir });
    expect(result).toEqual({ name: "good", root });
  });

  test("ignores non-json files in scopes directory", () => {
    const root = join(tmp, "project");
    mkdirSync(root, { recursive: true });
    writeScope("myproject", root);
    writeFileSync(join(scopesDir, "README.md"), "# Scopes");

    const result = detectScope(root, { scopesDir });
    expect(result).toEqual({ name: "myproject", root });
  });
});
