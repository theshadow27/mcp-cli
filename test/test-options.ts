import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";

type FileContent = string | Buffer | object;

interface TestOptionsInput extends Partial<typeof options> {
  /** Files to write into the temp dir. Keys are relative paths, values are content. Objects are JSON-serialized. */
  files?: Record<string, FileContent>;
}

function writeFile(path: string, content: FileContent): void {
  mkdirSync(dirname(path), { recursive: true });
  if (typeof content === "string") {
    writeFileSync(path, content);
  } else if (Buffer.isBuffer(content)) {
    writeFileSync(path, content);
  } else {
    writeFileSync(path, JSON.stringify(content, null, 2));
  }
}

export function testOptions(input?: TestOptionsInput) {
  const { files, ...overrides } = input ?? {};
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));

  options.MCP_CLI_DIR = dir;
  options.DB_PATH = join(dir, "state.db");
  options.MCP_CLI_CONFIG_PATH = join(dir, "config.json");
  options.SOCKET_PATH = join(dir, "mcpd.sock");
  options.PID_PATH = join(dir, "mcpd.pid");
  options.ALIASES_DIR = join(dir, "aliases");
  options.CACHE_DIR = join(dir, "cache");
  options.USER_SERVERS_PATH = join(dir, "servers.json");
  options.CLAUDE_CONFIG_PATH = join(dir, "claude.json");
  options.PROJECTS_DIR = join(dir, "projects");
  options.TYPES_PATH = join(dir, "mcp-cli.d.ts");
  options.LOCK_PATH = join(dir, "mcpd.lock");
  options.DAEMON_LOG_PATH = join(dir, "mcpd.log");
  options.DAEMON_LOG_BACKUP_PATH = join(dir, "mcpd.log.1");

  if (Object.keys(overrides).length > 0) Object.assign(options, overrides);

  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      writeFile(join(dir, relPath), content);
    }
  }

  return {
    ...options,
    dir,
    [Symbol.dispose]() {
      _restoreOptions();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
