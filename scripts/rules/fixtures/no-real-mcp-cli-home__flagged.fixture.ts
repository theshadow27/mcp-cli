/**
 * @rule no-real-mcp-cli-home
 * @expect 2
 * @path packages/daemon/src/site/browser/resolve-playwright.ts
 *
 * Two violations:
 *   1. join(homedir(), ".mcp-cli", "vendor") — homedir() + ".mcp-cli"
 *      string-building, the actual #3233 bug shape.
 *   2. existsSync("/home/testuser/.mcp-cli/staging") — a hardcoded absolute
 *      real-home path used directly as a filesystem call argument.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const vendorDir = join(homedir(), ".mcp-cli", "vendor", "playwright");

function stagingIsPresent(): boolean {
  return existsSync("/home/testuser/.mcp-cli/staging");
}

void vendorDir;
void stagingIsPresent;
