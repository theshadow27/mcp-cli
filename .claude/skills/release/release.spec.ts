import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArgs, updatePackageJson } from "./release.ts";

describe("parseArgs", () => {
  it("parses --version and --notes", () => {
    const result = parseArgs(["bun", "release.ts", "--version", "1.2.3", "--notes", "notes.md"]);
    expect(result).toEqual({ version: "1.2.3", notesFile: "notes.md", dryRun: false });
  });

  it("parses --dry-run flag", () => {
    const result = parseArgs(["bun", "release.ts", "--version", "0.1.0", "--notes", "n.md", "--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  it("throws when --version is missing", () => {
    expect(() => parseArgs(["bun", "release.ts", "--notes", "n.md"])).toThrow("--version is required");
  });

  it("throws when --notes is missing", () => {
    expect(() => parseArgs(["bun", "release.ts", "--version", "1.0.0"])).toThrow("--notes is required");
  });

  it("throws on invalid semver", () => {
    expect(() => parseArgs(["bun", "release.ts", "--version", "abc", "--notes", "n.md"])).toThrow("not valid semver");
  });
});

describe("updatePackageJson", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "release-test-"));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test", version: "0.1.0" }, null, 2) + "\n");
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true });
  });

  it("updates the version field", () => {
    updatePackageJson("1.0.0");
    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.version).toBe("1.0.0");
  });

  it("preserves other fields", () => {
    updatePackageJson("2.0.0");
    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("test");
  });

  it("writes trailing newline", () => {
    updatePackageJson("1.0.0");
    const raw = readFileSync(join(tmpDir, "package.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
  });
});
