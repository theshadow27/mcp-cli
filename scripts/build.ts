#!/usr/bin/env bun
import { $ } from "bun";

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;

const args = process.argv.slice(2);
const releaseMode = args.includes("--release");
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];

await $`mkdir -p dist`;

if (releaseMode) {
  const targets = targetArg ? TARGETS.filter((t) => t === targetArg) : [...TARGETS];

  if (targetArg && targets.length === 0) {
    console.error(`Unknown target: ${targetArg}`);
    console.error(`Valid targets: ${TARGETS.join(", ")}`);
    process.exit(1);
  }

  for (const target of targets) {
    const suffix = target.replace("bun-", "");
    console.log(`Building for ${suffix}...`);
    await Promise.all([
      $`bun build --compile --minify --target=${target} packages/daemon/src/index.ts --outfile dist/mcpd-${suffix}`,
      $`bun build --compile --minify --target=${target} packages/command/src/index.ts --outfile dist/mcp-${suffix}`,
    ]);
  }

  console.log("Release build complete.");
} else {
  // Dev build: current platform, simple names
  await Promise.all([
    $`bun build --compile --minify packages/daemon/src/index.ts --outfile dist/mcpd`,
    $`bun build --compile --minify packages/command/src/index.ts --outfile dist/mcp`,
  ]);
  console.log("Built: dist/mcpd, dist/mcp");
}
