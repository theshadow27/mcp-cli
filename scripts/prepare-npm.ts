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

export const PLATFORMS = [
  { suffix: "darwin-arm64", dir: "darwin-arm64" },
  { suffix: "darwin-x64", dir: "darwin-x64" },
  { suffix: "linux-x64", dir: "linux-x64" },
  { suffix: "linux-arm64", dir: "linux-arm64" },
] as const;

export const BINARIES = ["mcx", "mcpd", "mcpctl"] as const;

/** Parse version from CLI args or from a package.json string. */
export function parseVersion(args: string[], packageJsonText: string): string {
  const idx = args.indexOf("--version");
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return JSON.parse(packageJsonText).version;
}

/** Stamp version into a platform package.json string and return the result. */
export function stampPlatformPackage(pkgText: string, version: string): string {
  const pkg = JSON.parse(pkgText);
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Stamp optionalDependencies matching @theshadow27/mcp-cli-* in a root package.json string. */
export function stampOptionalDeps(pkgText: string, version: string): string {
  const pkg = JSON.parse(pkgText);
  if (pkg.optionalDependencies) {
    for (const key of Object.keys(pkg.optionalDependencies)) {
      if (key.startsWith("@theshadow27/mcp-cli-")) {
        pkg.optionalDependencies[key] = version;
      }
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const version = parseVersion(args, readFileSync("package.json", "utf-8"));

  console.log(`Preparing npm packages for version ${version}`);

  for (const platform of PLATFORMS) {
    const pkgPath = resolve(`npm/${platform.dir}/package.json`);
    const stamped = stampPlatformPackage(readFileSync(pkgPath, "utf-8"), version);
    writeFileSync(pkgPath, stamped);

    for (const binary of BINARIES) {
      const src = resolve(`dist/${binary}-${platform.suffix}`);
      const dst = resolve(`npm/${platform.dir}/bin/${binary}`);
      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
      console.log(`  ${binary}-${platform.suffix} → npm/${platform.dir}/bin/${binary}`);
    }
  }

  const rootPkgPath = resolve("package.json");
  const stamped = stampOptionalDeps(readFileSync(rootPkgPath, "utf-8"), version);
  writeFileSync(rootPkgPath, stamped);
  console.log(`Stamped optionalDependencies to ${version}`);

  console.log("Done.");
}
