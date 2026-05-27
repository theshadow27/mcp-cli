import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPackageForPath, isTestFile, loadFiles } from "./file-loader";

describe("isTestFile", () => {
  test("detects .spec.ts", () => expect(isTestFile("foo.spec.ts")).toBe(true));
  test("detects .test.ts", () => expect(isTestFile("bar.test.ts")).toBe(true));
  test("detects .spec.tsx", () => expect(isTestFile("baz.spec.tsx")).toBe(true));
  test("rejects plain .ts", () => expect(isTestFile("foo.ts")).toBe(false));
  test("rejects .d.ts", () => expect(isTestFile("foo.d.ts")).toBe(false));
});

describe("getPackageForPath", () => {
  const root = "/repo";
  test("packages/core path", () =>
    expect(getPackageForPath(root, "/repo/packages/core/src/foo.ts")).toBe("packages/core"));
  test("scripts path", () => expect(getPackageForPath(root, "/repo/scripts/build.ts")).toBe("scripts"));
  test("test path", () => expect(getPackageForPath(root, "/repo/test/helper.ts")).toBe("test"));
  test("unknown root", () => expect(getPackageForPath(root, "/repo/random/file.ts")).toBe(""));
});

describe("loadFiles", () => {
  test("loads .ts files from a directory", async () => {
    const tmp = join(tmpdir(), `file-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(join(tmp, "packages/core/src"), { recursive: true });
    writeFileSync(join(tmp, "packages/core/src/foo.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, "packages/core/src/foo.d.ts"), "declare const x: number;\n");
    writeFileSync(join(tmp, "packages/core/src/bar.spec.ts"), "test('x', () => {});\n");

    const files = await loadFiles({ repoRoot: tmp, roots: ["packages"] });
    const relPaths = [...files.values()].map((f) => f.relPath).sort();

    expect(relPaths).toContain("packages/core/src/foo.ts");
    expect(relPaths).toContain("packages/core/src/bar.spec.ts");
    expect(relPaths).not.toContain("packages/core/src/foo.d.ts");

    const foo = [...files.values()].find((f) => f.relPath === "packages/core/src/foo.ts");
    expect(foo?.isTest).toBe(false);
    expect(foo?.pkg).toBe("packages/core");

    const bar = [...files.values()].find((f) => f.relPath === "packages/core/src/bar.spec.ts");
    expect(bar?.isTest).toBe(true);
  });

  test("excludes fixture files", async () => {
    const tmp = join(tmpdir(), `file-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(join(tmp, "scripts/rules/fixtures"), { recursive: true });
    writeFileSync(join(tmp, "scripts/rules/fixtures/test.fixture.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, "scripts/rules/real.ts"), "export const y = 2;\n");

    const files = await loadFiles({ repoRoot: tmp, roots: ["scripts"] });
    const relPaths = [...files.values()].map((f) => f.relPath);

    expect(relPaths).not.toContain("scripts/rules/fixtures/test.fixture.ts");
    expect(relPaths).toContain("scripts/rules/real.ts");
  });

  test("applies filter", async () => {
    const tmp = join(tmpdir(), `file-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(join(tmp, "packages/core/src"), { recursive: true });
    mkdirSync(join(tmp, "packages/daemon/src"), { recursive: true });
    writeFileSync(join(tmp, "packages/core/src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(tmp, "packages/daemon/src/b.ts"), "export const b = 2;\n");

    const files = await loadFiles({ repoRoot: tmp, roots: ["packages"], filter: "core" });
    const relPaths = [...files.values()].map((f) => f.relPath);

    expect(relPaths).toContain("packages/core/src/a.ts");
    expect(relPaths).not.toContain("packages/daemon/src/b.ts");
  });
});
