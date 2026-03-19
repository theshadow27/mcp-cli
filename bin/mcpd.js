#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const os = require("node:os");

const PLATFORMS = {
  "darwin arm64": "@theshadow27/mcp-cli-darwin-arm64",
  "darwin x64": "@theshadow27/mcp-cli-darwin-x64",
  "linux x64": "@theshadow27/mcp-cli-linux-x64",
  "linux arm64": "@theshadow27/mcp-cli-linux-arm64",
};

const key = `${os.platform()} ${os.arch()}`;
const pkg = PLATFORMS[key];

if (!pkg) {
  console.error(`mcp-cli: unsupported platform ${key}`);
  console.error(`Supported: ${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(1);
}

let binPath;
try {
  binPath = join(require.resolve(`${pkg}/package.json`), "..", "bin", "mcpd");
} catch {
  console.error(`mcp-cli: platform package ${pkg} not found.`);
  console.error("Try reinstalling: npm install -g @theshadow27/mcp-cli");
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
