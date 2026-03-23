import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { PrepareNpmDeps } from "./prepare-npm";
import { BINARIES, PLATFORMS, parseVersion, prepareNpm, stampOptionalDeps, stampPlatformPackage } from "./prepare-npm";

describe("parseVersion", () => {
  test("reads version from --version arg", () => {
    expect(parseVersion(["--version", "1.2.3"], '{"version":"0.0.0"}')).toBe("1.2.3");
  });

  test("falls back to package.json version", () => {
    expect(parseVersion([], '{"version":"0.11.0"}')).toBe("0.11.0");
  });

  test("ignores --version flag with no following value", () => {
    expect(parseVersion(["--version"], '{"version":"0.11.0"}')).toBe("0.11.0");
  });

  test("--version takes precedence over package.json", () => {
    expect(parseVersion(["--version", "9.9.9"], '{"version":"1.0.0"}')).toBe("9.9.9");
  });
});

describe("stampPlatformPackage", () => {
  test("sets version in package.json", () => {
    const input = JSON.stringify({ name: "@theshadow27/mcp-cli-darwin-arm64", version: "0.0.0" });
    const output = stampPlatformPackage(input, "1.2.3");
    expect(JSON.parse(output).version).toBe("1.2.3");
  });

  test("preserves other fields", () => {
    const pkg = { name: "@theshadow27/mcp-cli-linux-x64", version: "0.0.0", os: ["linux"], cpu: ["x64"] };
    const output = stampPlatformPackage(JSON.stringify(pkg), "2.0.0");
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("@theshadow27/mcp-cli-linux-x64");
    expect(parsed.os).toEqual(["linux"]);
    expect(parsed.cpu).toEqual(["x64"]);
  });

  test("output ends with newline", () => {
    const output = stampPlatformPackage('{"version":"0.0.0"}', "1.0.0");
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("stampOptionalDeps", () => {
  const rootPkg = JSON.stringify({
    name: "@theshadow27/mcp-cli",
    version: "0.11.0",
    optionalDependencies: {
      "@theshadow27/mcp-cli-darwin-arm64": "0.0.0",
      "@theshadow27/mcp-cli-darwin-x64": "0.0.0",
      "@theshadow27/mcp-cli-linux-x64": "0.0.0",
      "@theshadow27/mcp-cli-linux-arm64": "0.0.0",
    },
  });

  test("stamps all mcp-cli optional deps to given version", () => {
    const output = JSON.parse(stampOptionalDeps(rootPkg, "1.5.0"));
    for (const dep of Object.keys(output.optionalDependencies)) {
      expect(output.optionalDependencies[dep]).toBe("1.5.0");
    }
  });

  test("does not modify non-mcp-cli optional deps", () => {
    const pkg = JSON.stringify({
      optionalDependencies: {
        "@theshadow27/mcp-cli-darwin-arm64": "0.0.0",
        "some-other-pkg": "^1.0.0",
      },
    });
    const output = JSON.parse(stampOptionalDeps(pkg, "2.0.0"));
    expect(output.optionalDependencies["some-other-pkg"]).toBe("^1.0.0");
    expect(output.optionalDependencies["@theshadow27/mcp-cli-darwin-arm64"]).toBe("2.0.0");
  });

  test("handles package with no optionalDependencies", () => {
    const pkg = JSON.stringify({ name: "foo", version: "1.0.0" });
    const output = JSON.parse(stampOptionalDeps(pkg, "2.0.0"));
    expect(output.optionalDependencies).toBeUndefined();
  });

  test("output ends with newline", () => {
    expect(stampOptionalDeps(rootPkg, "1.0.0").endsWith("\n")).toBe(true);
  });
});

describe("PLATFORMS constant", () => {
  test("contains all four supported platforms", () => {
    const dirs = PLATFORMS.map((p) => p.dir);
    expect(dirs).toContain("darwin-arm64");
    expect(dirs).toContain("darwin-x64");
    expect(dirs).toContain("linux-x64");
    expect(dirs).toContain("linux-arm64");
  });

  test("suffix matches dir", () => {
    for (const p of PLATFORMS) {
      expect(p.suffix).toBe(p.dir);
    }
  });
});

describe("BINARIES constant", () => {
  test("contains mcx, mcpd, mcpctl", () => {
    expect(BINARIES).toContain("mcx");
    expect(BINARIES).toContain("mcpd");
    expect(BINARIES).toContain("mcpctl");
  });
});

describe("prepareNpm", () => {
  const rootPkgJson = JSON.stringify({
    name: "@theshadow27/mcp-cli",
    version: "0.11.0",
    optionalDependencies: {
      "@theshadow27/mcp-cli-darwin-arm64": "0.0.0",
      "@theshadow27/mcp-cli-darwin-x64": "0.0.0",
      "@theshadow27/mcp-cli-linux-x64": "0.0.0",
      "@theshadow27/mcp-cli-linux-arm64": "0.0.0",
    },
  });

  const platformPkgJson = JSON.stringify({
    name: "@theshadow27/mcp-cli-darwin-arm64",
    version: "0.0.0",
  });

  function makeDeps(): {
    deps: PrepareNpmDeps;
    written: Map<string, string>;
    copied: Array<{ src: string; dst: string }>;
    chmods: Array<{ path: string; mode: number }>;
    logs: string[];
  } {
    const written = new Map<string, string>();
    const copied: Array<{ src: string; dst: string }> = [];
    const chmods: Array<{ path: string; mode: number }> = [];
    const logs: string[] = [];

    const deps: PrepareNpmDeps = {
      readFile: (path: string) => {
        if (path === "package.json" || path === resolve("package.json")) return rootPkgJson;
        return platformPkgJson;
      },
      writeFile: (path: string, data: string) => {
        written.set(path, data);
      },
      copyFile: (src: string, dst: string) => {
        copied.push({ src, dst });
      },
      chmod: (path: string, mode: number) => {
        chmods.push({ path, mode });
      },
      log: (msg: string) => {
        logs.push(msg);
      },
    };

    return { deps, written, copied, chmods, logs };
  }

  test("stamps all platform package.json files with version", () => {
    const { deps, written } = makeDeps();
    prepareNpm(["--version", "2.0.0"], deps);

    for (const platform of PLATFORMS) {
      const key = [...written.keys()].find((k) => k.includes(`npm/${platform.dir}/package.json`));
      expect(key).toBeDefined();
      const content = written.get(key as string) as string;
      expect(JSON.parse(content).version).toBe("2.0.0");
    }
  });

  test("copies all binaries for each platform", () => {
    const { deps, copied } = makeDeps();
    prepareNpm(["--version", "1.0.0"], deps);

    expect(copied).toHaveLength(PLATFORMS.length * BINARIES.length);
    for (const platform of PLATFORMS) {
      for (const binary of BINARIES) {
        expect(
          copied.some(
            (c) =>
              c.src.includes(`${binary}-${platform.suffix}`) && c.dst.includes(`npm/${platform.dir}/bin/${binary}`),
          ),
        ).toBe(true);
      }
    }
  });

  test("chmods all copied binaries to 755", () => {
    const { deps, chmods } = makeDeps();
    prepareNpm(["--version", "1.0.0"], deps);

    expect(chmods).toHaveLength(PLATFORMS.length * BINARIES.length);
    for (const entry of chmods) {
      expect(entry.mode).toBe(0o755);
    }
  });

  test("stamps root package.json optionalDependencies", () => {
    const { deps, written } = makeDeps();
    prepareNpm(["--version", "3.0.0"], deps);

    const rootKey = [...written.keys()].find((k) => k.endsWith("package.json") && !k.includes("/npm/"));
    expect(rootKey).toBeDefined();
    const parsed = JSON.parse(written.get(rootKey as string) as string);
    for (const dep of Object.keys(parsed.optionalDependencies)) {
      if (dep.startsWith("@theshadow27/mcp-cli-")) {
        expect(parsed.optionalDependencies[dep]).toBe("3.0.0");
      }
    }
  });

  test("logs progress messages", () => {
    const { deps, logs } = makeDeps();
    prepareNpm(["--version", "1.0.0"], deps);

    expect(logs.some((l) => l.includes("Preparing npm packages for version 1.0.0"))).toBe(true);
    expect(logs.some((l) => l.includes("Done."))).toBe(true);
    expect(logs.some((l) => l.includes("Stamped optionalDependencies"))).toBe(true);
  });

  test("reads version from package.json when no --version arg", () => {
    const { deps, logs } = makeDeps();
    prepareNpm([], deps);

    expect(logs.some((l) => l.includes("version 0.11.0"))).toBe(true);
  });
});
