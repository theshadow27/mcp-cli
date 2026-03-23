import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BINARIES, PLATFORMS } from "./prepare-npm";

const ROOT = resolve(import.meta.dir, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf-8"));
}

describe("root package npm pack structure", () => {
  const pkg = readJson("package.json") as {
    bin: Record<string, string>;
    files: string[];
    optionalDependencies: Record<string, string>;
  };

  test("bin entries point to JS wrappers, not compiled binaries", () => {
    expect(pkg.bin).toBeDefined();
    for (const [name, path] of Object.entries(pkg.bin)) {
      expect(path).toEndWith(".js");
      expect(path).toStartWith("bin/");
      expect(existsSync(resolve(ROOT, path))).toBe(true);
    }
  });

  test("bin wrappers are Node.js scripts (not Bun binaries)", () => {
    for (const path of Object.values(pkg.bin)) {
      const content = readFileSync(resolve(ROOT, path), "utf-8");
      expect(content).toStartWith("#!/usr/bin/env node");
    }
  });

  test("bin wrappers reference correct platform packages", () => {
    for (const path of Object.values(pkg.bin)) {
      const content = readFileSync(resolve(ROOT, path), "utf-8");
      expect(content).toContain("@theshadow27/mcp-cli-");
      expect(content).toContain("spawnSync");
    }
  });

  test("files field includes bin/ and source but not dist/", () => {
    expect(pkg.files).toContain("bin/");
    expect(pkg.files).not.toContain("dist/");
    expect(pkg.files).not.toContain("npm/");
  });

  test("files field excludes spec files", () => {
    expect(pkg.files).toContain("!**/*.spec.ts");
  });

  test("optionalDependencies lists all platform packages", () => {
    const deps = Object.keys(pkg.optionalDependencies);
    for (const platform of PLATFORMS) {
      expect(deps).toContain(`@theshadow27/mcp-cli-${platform.dir}`);
    }
  });

  test("all three binaries have wrappers", () => {
    const binNames = Object.keys(pkg.bin);
    for (const binary of BINARIES) {
      expect(binNames).toContain(binary);
    }
  });
});

describe("platform package npm pack structure", () => {
  for (const platform of PLATFORMS) {
    describe(platform.dir, () => {
      const pkgPath = `npm/${platform.dir}/package.json`;
      const pkg = readJson(pkgPath) as {
        name: string;
        files: string[];
        os: string[];
        cpu: string[];
      };

      test("files field is exactly ['bin/']", () => {
        expect(pkg.files).toEqual(["bin/"]);
      });

      test("has correct os and cpu selectors", () => {
        const [os, cpu] = platform.dir.split("-");
        expect(pkg.os).toEqual([os]);
        expect(pkg.cpu).toEqual([cpu]);
      });

      test("name matches expected pattern", () => {
        expect(pkg.name).toBe(`@theshadow27/mcp-cli-${platform.dir}`);
      });

      test("bin/ directory exists", () => {
        expect(existsSync(resolve(ROOT, `npm/${platform.dir}/bin`))).toBe(true);
      });

      test("no unexpected files outside bin/ and package.json", () => {
        const dir = resolve(ROOT, `npm/${platform.dir}`);
        const entries = Array.from(new Bun.Glob("*").scanSync({ cwd: dir, dot: false }));
        // Only package.json and bin/ should exist at the top level
        const allowed = new Set(["package.json", "bin"]);
        for (const entry of entries) {
          expect(allowed.has(entry)).toBe(true);
        }
      });
    });
  }
});

describe("release workflow job ordering", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf-8");

  test("publish job depends on publish-platform", () => {
    // The root publish must wait for platform packages to be available
    expect(workflow).toContain("publish-platform");
    // Find the publish job's needs — it should include publish-platform
    const publishMatch = workflow.match(/publish:\s*\n\s*needs:\s*\[([^\]]+)\]/);
    expect(publishMatch).not.toBeNull();
    const needs = publishMatch?.[1] ?? "";
    expect(needs).toContain("publish-platform");
  });

  test("publish-platform job depends on build", () => {
    const match = workflow.match(/publish-platform:\s*\n\s*needs:\s*(\w+|(\[[^\]]+\]))/);
    expect(match).not.toBeNull();
    expect(match?.[1] ?? "").toContain("build");
  });

  test("publish is gated on NPM_PUBLISH_ENABLED", () => {
    // Both publish jobs should check the flag
    const publishSections = workflow.split(/\n {2}\w+:/);
    for (const section of publishSections) {
      if (section.includes("npm publish") && !section.includes("Publish platform")) {
        expect(workflow).toContain("NPM_PUBLISH_ENABLED");
      }
    }
  });
});

describe("prepare-npm.ts removes .gitkeep", () => {
  test("script imports unlinkSync for .gitkeep cleanup", () => {
    const script = readFileSync(resolve(ROOT, "scripts/prepare-npm.ts"), "utf-8");
    expect(script).toContain("unlinkSync");
    expect(script).toContain(".gitkeep");
  });
});
