#!/usr/bin/env bun
import { $ } from "bun";

await $`mkdir -p dist`;
await Promise.all([
  $`bun build --compile --minify packages/daemon/src/index.ts --outfile dist/mcpd`,
  $`bun build --compile --minify packages/command/src/index.ts --outfile dist/mcp`,
  $`bun build --compile --minify packages/control/src/index.ts --outfile dist/mcpctl`,
]);
console.log("Built: dist/mcpd, dist/mcp, dist/mcpctl");
