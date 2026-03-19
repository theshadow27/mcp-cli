#!/usr/bin/env bun
/**
 * Prepare npm platform packages for publishing.
 *
 * Expects compiled binaries in dist/ (from `bun scripts/build.ts --release`).
 * Copies them into npm/<platform>/bin/ and stamps versions.
 *
 * Usage:
 *   bun scripts/prepare-npm.ts                  # uses version from package.json
 *   bun scripts/prepare-npm.ts --version 0.11.0 # override version
 */
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PLATFORMS = [
  { suffix: "darwin-arm64", dir: "darwin-arm64" },
  { suffix: "darwin-x64", dir: "darwin-x64" },
  { suffix: "linux-x64", dir: "linux-x64" },
  { suffix: "linux-arm64", dir: "linux-arm64" },
] as const;

const BINARIES = ["mcx", "mcpd", "mcpctl"] as const;

// Parse version
const args = process.argv.slice(2);
const versionArgIdx = args.indexOf("--version");
let version: string;
if (versionArgIdx !== -1 && args[versionArgIdx + 1]) {
  version = args[versionArgIdx + 1];
} else {
  const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
  version = rootPkg.version;
}

console.log(`Preparing npm packages for version ${version}`);

for (const platform of PLATFORMS) {
  const pkgPath = resolve(`npm/${platform.dir}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  for (const binary of BINARIES) {
    const src = resolve(`dist/${binary}-${platform.suffix}`);
    const dst = resolve(`npm/${platform.dir}/bin/${binary}`);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
    console.log(`  ${binary}-${platform.suffix} → npm/${platform.dir}/bin/${binary}`);
  }
}

// Stamp optionalDependencies in root package.json
const rootPkgPath = resolve("package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
if (rootPkg.optionalDependencies) {
  for (const key of Object.keys(rootPkg.optionalDependencies)) {
    if (key.startsWith("@theshadow27/mcp-cli-")) {
      rootPkg.optionalDependencies[key] = version;
    }
  }
  writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
  console.log(`Stamped optionalDependencies to ${version}`);
}

console.log("Done.");
