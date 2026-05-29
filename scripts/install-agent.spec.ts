import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstallDeps,
  findVersionEntry,
  installAgent,
  installFromArchive,
  loadGrid,
  parseInstallAgentArgs,
  readSidecarChecksum,
  sha256File,
} from "./install-agent";

// ── Arg parsing ────────────────────────────────────────────────────

describe("parseInstallAgentArgs", () => {
  test("parses provider@version", () => {
    const args = parseInstallAgentArgs(["claude@2.1.119"]);
    expect(args).toEqual({ provider: "claude", version: "2.1.119", offline: false });
  });

  test("parses --offline flag", () => {
    const args = parseInstallAgentArgs(["--offline", "claude@2.1.119"]);
    expect(args).toEqual({ provider: "claude", version: "2.1.119", offline: true });
  });

  test("--offline can follow the spec", () => {
    const args = parseInstallAgentArgs(["codex@0.30.1", "--offline"]);
    expect(args).toEqual({ provider: "codex", version: "0.30.1", offline: true });
  });

  test("rejects missing spec", () => {
    expect(() => parseInstallAgentArgs([])).toThrow("Usage:");
  });

  test("rejects spec without @", () => {
    expect(() => parseInstallAgentArgs(["claude"])).toThrow("expected provider@version");
  });

  test("rejects spec with @ at position 0", () => {
    expect(() => parseInstallAgentArgs(["@2.1.119"])).toThrow("expected provider@version");
  });

  test("rejects unknown flags", () => {
    expect(() => parseInstallAgentArgs(["--foo", "claude@2.1.119"])).toThrow("Unknown flag");
  });
});

// ── Grid loading ───────────────────────────────────────────────────

describe("loadGrid", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `install-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads a valid versions.yaml", () => {
    const yaml = `
providers:
  - name: claude
    track: patch
    versions:
      - version: "2.1.119"
        outcome: pass
        archive: binaries/claude-2.1.119.tgz
`;
    writeFileSync(join(tmpDir, "versions.yaml"), yaml);
    const grid = loadGrid(join(tmpDir, "versions.yaml"));
    expect(grid.providers).toHaveLength(1);
    expect(grid.providers[0]?.name).toBe("claude");
  });

  test("throws on missing file", () => {
    expect(() => loadGrid(join(tmpDir, "missing.yaml"))).toThrow("Cannot read");
  });

  test("throws on invalid YAML content", () => {
    writeFileSync(join(tmpDir, "bad.yaml"), "providers: [{ invalid");
    expect(() => loadGrid(join(tmpDir, "bad.yaml"))).toThrow();
  });

  test("throws on schema validation failure", () => {
    writeFileSync(join(tmpDir, "empty.yaml"), "providers: []");
    expect(() => loadGrid(join(tmpDir, "empty.yaml"))).toThrow("validation failed");
  });
});

// ── findVersionEntry ───────────────────────────────────────────────

describe("findVersionEntry", () => {
  const grid = {
    providers: [
      {
        name: "claude" as const,
        track: "patch" as const,
        enabled: true,
        versions: [
          { version: "2.1.119", outcome: "pass" as const, archive: "binaries/claude-2.1.119.tgz" },
          { version: "latest", outcome: "untested" as const },
        ],
      },
    ],
  };

  test("finds existing version", () => {
    const entry = findVersionEntry(grid, "claude", "2.1.119");
    expect(entry).not.toBeNull();
    expect(entry?.archive).toBe("binaries/claude-2.1.119.tgz");
  });

  test("returns null for unknown provider", () => {
    expect(findVersionEntry(grid, "unknown", "1.0.0")).toBeNull();
  });

  test("returns null for unknown version", () => {
    expect(findVersionEntry(grid, "claude", "9.9.9")).toBeNull();
  });
});

// ── SHA256 helpers ─────────────────────────────────────────────────

describe("sha256File", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sha256-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("computes correct sha256", async () => {
    const path = join(tmpDir, "test.txt");
    writeFileSync(path, "hello world\n");
    const hash = await sha256File(path);
    expect(hash).toBe("a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447");
  });
});

describe("readSidecarChecksum", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads hash-only format", () => {
    const tgzPath = join(tmpDir, "test.tgz");
    writeFileSync(tgzPath, "dummy");
    writeFileSync(`${tgzPath}.sha256`, "abcd".repeat(16));
    expect(readSidecarChecksum(tgzPath)).toBe("abcd".repeat(16));
  });

  test("reads hash-with-filename format", () => {
    const tgzPath = join(tmpDir, "test.tgz");
    writeFileSync(tgzPath, "dummy");
    writeFileSync(`${tgzPath}.sha256`, `${"abcd".repeat(16)}  test.tgz\n`);
    expect(readSidecarChecksum(tgzPath)).toBe("abcd".repeat(16));
  });

  test("throws on missing sidecar", () => {
    expect(() => readSidecarChecksum(join(tmpDir, "missing.tgz"))).toThrow("sidecar not found");
  });

  test("throws on invalid hash", () => {
    const tgzPath = join(tmpDir, "test.tgz");
    writeFileSync(tgzPath, "dummy");
    writeFileSync(`${tgzPath}.sha256`, "not-a-hash");
    expect(() => readSidecarChecksum(tgzPath)).toThrow("Invalid sha256");
  });
});

// ── Archive install (integration-style with real tgz) ──────────────

describe("installFromArchive", () => {
  let tmpDir: string;
  let gridDir: string;
  let destDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    gridDir = join(tmpDir, "agent-grid");
    destDir = join(tmpDir, "dest");
    mkdirSync(join(gridDir, "binaries"), { recursive: true });
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(overrides?: Partial<InstallDeps>): InstallDeps {
    return {
      agentsDir: destDir,
      gridDir,
      versionsPath: join(gridDir, "versions.yaml"),
      spawn: Bun.spawn,
      log: () => {},
      error: () => {},
      ...overrides,
    };
  }

  async function createTestArchive(provider: string, version: string): Promise<string> {
    const binaryName = `${provider}-${version}`;
    const binaryContent = `#!/bin/sh\necho "${provider} ${version}"`;
    const binaryPath = join(tmpDir, binaryName);
    writeFileSync(binaryPath, binaryContent, { mode: 0o755 });

    const tgzPath = join(gridDir, "binaries", `${binaryName}.tgz`);
    const proc = Bun.spawn(
      ["tar", "czf", tgzPath, "--uid", "0", "--gid", "0", "--numeric-owner", "-C", tmpDir, binaryName],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;

    // Write sha256 sidecar
    const hash = await sha256File(tgzPath);
    writeFileSync(`${tgzPath}.sha256`, `${hash}  ${binaryName}.tgz\n`);

    // Clean up the loose binary
    rmSync(binaryPath);

    return tgzPath;
  }

  test("extracts archive and verifies sha256", async () => {
    await createTestArchive("testprov", "1.0.0");

    const entry = {
      version: "1.0.0",
      outcome: "pass" as const,
      archive: "binaries/testprov-1.0.0.tgz",
    };

    const result = await installFromArchive(entry, "testprov", destDir, makeDeps());
    expect(result.binaryPath).toContain("testprov-1.0.0");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const content = readFileSync(result.binaryPath, "utf-8");
    expect(content).toContain("testprov 1.0.0");
  });

  test("fails on sha256 mismatch", async () => {
    await createTestArchive("testprov", "1.0.0");
    // Corrupt the sidecar
    const sidecarPath = join(gridDir, "binaries", "testprov-1.0.0.tgz.sha256");
    writeFileSync(sidecarPath, `${"0".repeat(64)}  testprov-1.0.0.tgz\n`);

    const entry = {
      version: "1.0.0",
      outcome: "pass" as const,
      archive: "binaries/testprov-1.0.0.tgz",
    };

    await expect(installFromArchive(entry, "testprov", destDir, makeDeps())).rejects.toThrow("SHA256 mismatch");
  });

  test("fails when archive file is missing", async () => {
    const entry = {
      version: "1.0.0",
      outcome: "pass" as const,
      archive: "binaries/nonexistent.tgz",
    };

    await expect(installFromArchive(entry, "testprov", destDir, makeDeps())).rejects.toThrow("Archive not found");
  });

  test("fails when entry has no archive path", async () => {
    const entry = { version: "1.0.0", outcome: "untested" as const };

    await expect(installFromArchive(entry, "testprov", destDir, makeDeps())).rejects.toThrow("No archive path");
  });
});

// ── Full installAgent flow ─────────────────────────────────────────

describe("installAgent", () => {
  let tmpDir: string;
  let gridDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `install-full-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    gridDir = join(tmpDir, "agent-grid");
    agentsDir = join(tmpDir, "agents");
    mkdirSync(join(gridDir, "binaries"), { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(): InstallDeps {
    return {
      agentsDir,
      gridDir,
      versionsPath: join(gridDir, "versions.yaml"),
      spawn: Bun.spawn,
      log: () => {},
      error: () => {},
    };
  }

  async function setupGrid(): Promise<void> {
    const binaryName = "mock-1.0.0";
    const binaryPath = join(tmpDir, binaryName);
    writeFileSync(binaryPath, "#!/bin/sh\necho ok", { mode: 0o755 });

    const tgzPath = join(gridDir, "binaries", `${binaryName}.tgz`);
    const proc = Bun.spawn(
      ["tar", "czf", tgzPath, "--uid", "0", "--gid", "0", "--numeric-owner", "-C", tmpDir, binaryName],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;

    const hash = await sha256File(tgzPath);
    writeFileSync(`${tgzPath}.sha256`, `${hash}  ${binaryName}.tgz\n`);
    rmSync(binaryPath);

    const yaml = `
providers:
  - name: mock
    track: patch
    versions:
      - version: "1.0.0"
        outcome: pass
        archive: binaries/mock-1.0.0.tgz
`;
    writeFileSync(join(gridDir, "versions.yaml"), yaml);
  }

  test("installs from archive in offline mode", async () => {
    await setupGrid();

    const result = await installAgent({ provider: "mock", version: "1.0.0", offline: true }, makeDeps());

    expect(result.source).toBe("archive");
    expect(result.provider).toBe("mock");
    expect(result.version).toBe("1.0.0");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throws on unknown provider", async () => {
    await setupGrid();

    await expect(
      installAgent({ provider: "nonexistent", version: "1.0.0", offline: true }, makeDeps()),
    ).rejects.toThrow("Unknown provider");
  });

  test("throws on unknown version", async () => {
    await setupGrid();

    await expect(installAgent({ provider: "mock", version: "9.9.9", offline: true }, makeDeps())).rejects.toThrow(
      "not found for mock",
    );
  });

  test("falls back to archive when registry has no npm mapping", async () => {
    await setupGrid();

    const result = await installAgent({ provider: "mock", version: "1.0.0", offline: false }, makeDeps());

    expect(result.source).toBe("archive");
  });
});
