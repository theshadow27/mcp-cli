import { describe, expect, test } from "bun:test";
import { BINARIES, PLATFORMS, parseVersion, stampOptionalDeps, stampPlatformPackage } from "./prepare-npm";

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
