/**
 * @rule no-real-mcp-cli-home
 * @expect 0
 * @path packages/daemon/src/site/browser/resolve-playwright.ts
 *
 * Zero violations expected. Covers:
 *   - options.MCP_CLI_DIR (the correct, override-respecting pattern)
 *   - homedir() combined with an unrelated literal (".claude.json") — not
 *     the ".mcp-cli" this rule cares about
 *   - tmpdir() + mkdtempSync — test isolation, never the real home
 *   - a tilde-form doc/help string passed to console.error — prose, not a
 *     filesystem call (Node's fs functions never expand "~")
 *   - a synthetic /home/<user>/.mcp-cli fixture path used as object data,
 *     never passed to a call that would touch the filesystem
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { options } from "@mcp-cli/core";

function vendorDir(): string {
  return join(options.MCP_CLI_DIR, "vendor", "playwright");
}

const claudeConfigPath = join(homedir(), ".claude.json");

function isolatedTestDir(): string {
  return mkdtempSync(join(tmpdir(), "mcp-cli-test-"));
}

function warnManualInstall(): void {
  console.error("Install manually: cd ~/.mcp-cli/vendor/playwright && bun add playwright");
}

const fixtureRow = { filePath: "/home/user/.mcp-cli/aliases/my-tool.ts" };

void vendorDir;
void claudeConfigPath;
void isolatedTestDir;
void warnManualInstall;
void fixtureRow;
