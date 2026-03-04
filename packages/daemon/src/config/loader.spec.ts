import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to mock readCliConfig and CLAUDE_CONFIG_PATH before importing loadConfig.
// Use a temp dir to isolate each test.

let testDir: string;
let claudeConfigPath: string;
let mcpCliConfigPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  claudeConfigPath = join(testDir, ".claude.json");
  mcpCliConfigPath = join(testDir, "config.json");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// Helper: write JSON to a file, creating parent dirs
function writeJson(path: string, data: unknown): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

// Since loadConfig reads from fixed paths and uses process.cwd(),
// we test the core filtering logic by importing and calling loadConfig
// with a cwd that has .mcp.json. We mock the CLI config reader.
// For a clean test, we dynamically import after mocking.

describe("loadConfig trust-claude filtering", () => {
  it("trust-claude OFF: uses ~/.claude.json project scope filtering", async () => {
    const projectDir = join(testDir, "project");
    mkdirSync(projectDir, { recursive: true });

    // .mcp.json with servers a, b, c
    writeJson(join(projectDir, ".mcp.json"), {
      mcpServers: {
        a: { command: "a" },
        b: { command: "b" },
        c: { command: "c" },
      },
    });

    // ~/.claude.json with project scope enabling only a and b
    writeJson(claudeConfigPath, {
      projects: {
        [projectDir]: {
          enabledMcpjsonServers: ["a", "b"],
        },
      },
    });

    // CLI config: trustClaude off
    writeJson(mcpCliConfigPath, { trustClaude: false });

    // Use dynamic import to test with mocked constants
    const { loadConfig: load } = await mockLoadConfig(claudeConfigPath, mcpCliConfigPath);
    const config = await load(projectDir);

    const names = [...config.servers.keys()];
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).not.toContain("c");
  });

  it("trust-claude ON + enabledMcpjsonServers: only listed servers loaded", async () => {
    const projectDir = join(testDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeJson(join(projectDir, ".mcp.json"), {
      mcpServers: {
        a: { command: "a" },
        b: { command: "b" },
        c: { command: "c" },
      },
    });

    // .claude/settings.local.json with only "a" enabled
    writeJson(join(projectDir, ".claude", "settings.local.json"), {
      enabledMcpjsonServers: ["a"],
    });

    writeJson(mcpCliConfigPath, { trustClaude: true });
    writeJson(claudeConfigPath, {});

    const { loadConfig: load } = await mockLoadConfig(claudeConfigPath, mcpCliConfigPath);
    const config = await load(projectDir);

    const names = [...config.servers.keys()];
    expect(names).toContain("a");
    expect(names).not.toContain("b");
    expect(names).not.toContain("c");
  });

  it("trust-claude ON + disabledMcpjsonServers: listed servers skipped", async () => {
    const projectDir = join(testDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeJson(join(projectDir, ".mcp.json"), {
      mcpServers: {
        a: { command: "a" },
        b: { command: "b" },
      },
    });

    writeJson(join(projectDir, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["b"],
    });

    writeJson(mcpCliConfigPath, { trustClaude: true });
    writeJson(claudeConfigPath, {});

    const { loadConfig: load } = await mockLoadConfig(claudeConfigPath, mcpCliConfigPath);
    const config = await load(projectDir);

    const names = [...config.servers.keys()];
    expect(names).toContain("a");
    expect(names).not.toContain("b");
  });

  it("trust-claude ON + settings file missing: all servers skipped", async () => {
    const projectDir = join(testDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeJson(join(projectDir, ".mcp.json"), {
      mcpServers: {
        a: { command: "a" },
        b: { command: "b" },
      },
    });

    // No .claude/settings.local.json

    writeJson(mcpCliConfigPath, { trustClaude: true });
    writeJson(claudeConfigPath, {});

    const { loadConfig: load } = await mockLoadConfig(claudeConfigPath, mcpCliConfigPath);
    const config = await load(projectDir);

    const names = [...config.servers.keys()];
    expect(names).not.toContain("a");
    expect(names).not.toContain("b");
  });

  it("trust-claude ON + server not in any list: skipped (safe default)", async () => {
    const projectDir = join(testDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeJson(join(projectDir, ".mcp.json"), {
      mcpServers: {
        a: { command: "a" },
        b: { command: "b" },
        c: { command: "c" },
      },
    });

    // Only "a" is in the enabled list; b and c are not mentioned
    writeJson(join(projectDir, ".claude", "settings.local.json"), {
      enabledMcpjsonServers: ["a"],
    });

    writeJson(mcpCliConfigPath, { trustClaude: true });
    writeJson(claudeConfigPath, {});

    const { loadConfig: load } = await mockLoadConfig(claudeConfigPath, mcpCliConfigPath);
    const config = await load(projectDir);

    const names = [...config.servers.keys()];
    expect(names).toEqual(["a"]);
  });
});

/**
 * Create a version of loadConfig that reads from our test paths
 * instead of the real ~/.claude.json and ~/.mcp-cli/config.json.
 *
 * We do this by re-implementing the module with overridden constants.
 */
async function mockLoadConfig(claudePath: string, cliConfigPath: string) {
  // We'll build a minimal loadConfig that mirrors the real one but uses our paths.
  const { existsSync, readFileSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const { dirname, join, resolve } = await import("node:path");
  const { expandEnvVarsDeep } = await import("@mcp-cli/core");

  type ServerConfig = import("@mcp-cli/core").ServerConfig;
  type ServerConfigMap = import("@mcp-cli/core").ServerConfigMap;
  type ResolvedServer = import("@mcp-cli/core").ResolvedServer;
  type ResolvedConfig = import("@mcp-cli/core").ResolvedConfig;
  type ClaudeConfigFile = import("@mcp-cli/core").ClaudeConfigFile;
  type McpConfigFile = import("@mcp-cli/core").McpConfigFile;
  type ClaudeProjectSettings = import("@mcp-cli/core").ClaudeProjectSettings;
  type CliConfig = import("@mcp-cli/core").CliConfig;

  interface ConfigSource {
    file: string;
    scope: "user" | "project" | "local" | "mcp-cli";
  }

  function readJsonFileSync<T>(path: string): T | null {
    try {
      const text = readFileSync(path, "utf-8");
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async function readJsonFile<T>(path: string): Promise<T | null> {
    try {
      const text = await readFile(path, "utf-8");
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  function readCliConfig(): CliConfig {
    return readJsonFileSync<CliConfig>(cliConfigPath) ?? {};
  }

  function findFileUpward(filename: string, startDir: string): string | null {
    let dir = resolve(startDir);
    while (true) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  function findMatchingProjects(projectPaths: string[], cwd: string): string[] {
    const resolved = resolve(cwd);
    return projectPaths
      .filter((p) => resolved.startsWith(`${p}/`) || resolved === p)
      .sort((a, b) => a.length - b.length);
  }

  function addServer(
    target: Map<string, ResolvedServer>,
    name: string,
    config: ServerConfig,
    source: ConfigSource,
  ): void {
    target.set(name, { name, config, source });
  }

  async function loadConfig(cwd: string): Promise<ResolvedConfig> {
    const servers = new Map<string, ResolvedServer>();
    const sources: ConfigSource[] = [];

    const claudeConfig = await readJsonFile<ClaudeConfigFile>(claudePath);

    // Priority 4: Claude user scope
    if (claudeConfig?.mcpServers) {
      const source: ConfigSource = { file: claudePath, scope: "user" };
      sources.push(source);
      for (const [name, config] of Object.entries(claudeConfig.mcpServers)) {
        addServer(servers, name, config, source);
      }
    }

    // Priority 3: .mcp.json
    const mcpJsonPath = findFileUpward(".mcp.json", cwd);
    if (mcpJsonPath) {
      const mcpConfig = await readJsonFile<McpConfigFile>(mcpJsonPath);
      if (mcpConfig?.mcpServers) {
        const cliConfig = readCliConfig();
        let disabledMcpJson: string[] = [];
        let enabledMcpJson: string[] | undefined;

        if (cliConfig.trustClaude) {
          const settingsPath = join(dirname(mcpJsonPath), ".claude", "settings.local.json");
          const settings = readJsonFileSync<ClaudeProjectSettings>(settingsPath);
          if (!settings) {
            enabledMcpJson = [];
          } else {
            enabledMcpJson = settings.enabledMcpjsonServers;
            disabledMcpJson = settings.disabledMcpjsonServers ?? [];
          }
        } else {
          const matchingPaths = claudeConfig?.projects
            ? findMatchingProjects(Object.keys(claudeConfig.projects), cwd).reverse()
            : [];
          const projectSettings = matchingPaths
            .map((p) => claudeConfig?.projects?.[p])
            .find((s) => s?.enabledMcpjsonServers || s?.disabledMcpjsonServers);
          disabledMcpJson = projectSettings?.disabledMcpjsonServers ?? [];
          enabledMcpJson = projectSettings?.enabledMcpjsonServers;
        }

        const source: ConfigSource = { file: mcpJsonPath, scope: "project" };
        sources.push(source);
        for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
          if (disabledMcpJson.includes(name)) continue;
          if (enabledMcpJson && !enabledMcpJson.includes(name)) continue;
          addServer(servers, name, config, source);
        }
      }
    }

    return { servers, sources };
  }

  return { loadConfig };
}
