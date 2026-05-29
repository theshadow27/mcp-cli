#!/usr/bin/env bun
/**
 * Install an agent provider binary at a specific version.
 *
 * Resolution order: npm registry first, LFS archive fallback.
 * All installs are sha256-verified against the sidecar checksum.
 *
 * Usage:
 *   bun scripts/install-agent.ts claude@2.1.119
 *   bun scripts/install-agent.ts --offline claude@2.1.119
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { options } from "@mcp-cli/core";
import { type VersionEntry, type VersionsGrid, validateVersionsGrid } from "../agent-grid/versions-schema";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GRID_DIR = resolve(REPO_ROOT, "agent-grid");
const VERSIONS_PATH = resolve(GRID_DIR, "versions.yaml");

// ── Provider → npm package mapping ─────────────────────────────────

const NPM_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
};

// ── Types ──────────────────────────────────────────────────────────

export interface InstallResult {
  provider: string;
  version: string;
  binaryPath: string;
  source: "registry" | "archive";
  sha256: string;
}

export interface InstallArgs {
  provider: string;
  version: string;
  offline: boolean;
}

export interface InstallDeps {
  agentsDir: string;
  gridDir: string;
  versionsPath: string;
  spawn: typeof Bun.spawn;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultDeps: InstallDeps = {
  agentsDir: options.AGENTS_DIR,
  gridDir: GRID_DIR,
  versionsPath: VERSIONS_PATH,
  spawn: Bun.spawn,
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

// ── Argument parsing ───────────────────────────────────────────────

export function parseInstallAgentArgs(argv: string[]): InstallArgs {
  let offline = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--offline") {
      offline = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error("Usage: install-agent [--offline] <provider@version>");
  }

  const spec = positional[0] as string;
  const atIdx = spec.indexOf("@");
  if (atIdx < 1) {
    throw new Error(`Invalid spec "${spec}" — expected provider@version (e.g. claude@2.1.119)`);
  }

  const provider = spec.slice(0, atIdx);
  const version = spec.slice(atIdx + 1);
  if (!version) {
    throw new Error(`Missing version in "${spec}" — expected provider@version`);
  }

  return { provider, version, offline };
}

// ── Grid loading ───────────────────────────────────────────────────

export function loadGrid(versionsPath: string): VersionsGrid {
  let text: string;
  try {
    text = readFileSync(versionsPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read ${versionsPath}: ${(err as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    throw new Error(`Invalid YAML: ${(err as Error).message}`);
  }

  const result = validateVersionsGrid(raw);
  if (!result.ok) {
    const msgs = result.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`versions.yaml validation failed: ${msgs}`);
  }

  return result.grid;
}

export function findVersionEntry(grid: VersionsGrid, provider: string, version: string): VersionEntry | null {
  const prov = grid.providers.find((p) => p.name === provider);
  if (!prov) return null;
  return prov.versions.find((v) => v.version === version) ?? null;
}

// ── SHA256 helpers ─────────────────────────────────────────────────

export async function sha256File(path: string): Promise<string> {
  const file = Bun.file(path);
  const hasher = new Bun.CryptoHasher("sha256");
  const bytes = await file.arrayBuffer();
  hasher.update(new Uint8Array(bytes));
  return hasher.digest("hex");
}

export function readSidecarChecksum(tgzPath: string): string {
  const sidecarPath = `${tgzPath}.sha256`;
  let text: string;
  try {
    text = readFileSync(sidecarPath, "utf-8").trim();
  } catch {
    throw new Error(`Checksum sidecar not found: ${sidecarPath}`);
  }

  // Format: "<hash>  <filename>" or just "<hash>"
  const hash = text.split(/\s+/)[0] as string;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`Invalid sha256 in sidecar ${sidecarPath}: "${hash}"`);
  }
  return hash;
}

// ── Registry install (npm pack) ────────────────────────────────────

export async function installFromRegistry(
  provider: string,
  version: string,
  destDir: string,
  deps: InstallDeps,
): Promise<{ binaryPath: string; sha256: string } | null> {
  const npmPkg = NPM_PACKAGES[provider];
  if (!npmPkg) return null;

  const tmpDir = join(destDir, ".tmp-registry");
  mkdirSync(tmpDir, { recursive: true });

  try {
    deps.error(`registry: npm pack ${npmPkg}@${version}...`);
    const pack = deps.spawn(["npm", "pack", `${npmPkg}@${version}`, "--pack-destination", tmpDir], {
      cwd: tmpDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const packExit = await pack.exited;
    if (packExit !== 0) {
      const stderr = await new Response(pack.stderr).text();
      deps.error(`registry: npm pack failed (exit ${packExit}): ${stderr.trim()}`);
      return null;
    }

    const packOut = (await new Response(pack.stdout).text()).trim();
    const tgzName = packOut.split("\n").pop()?.trim();
    if (!tgzName) {
      deps.error("registry: npm pack produced no output");
      return null;
    }

    const tgzPath = join(tmpDir, tgzName);
    if (!existsSync(tgzPath)) {
      deps.error(`registry: expected tarball not found: ${tgzPath}`);
      return null;
    }

    deps.error("registry: extracting package...");
    const extract = deps.spawn(["tar", "xzf", tgzPath, "-C", tmpDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const extractExit = await extract.exited;
    if (extractExit !== 0) {
      const stderr = await new Response(extract.stderr).text();
      deps.error(`registry: extraction failed: ${stderr.trim()}`);
      return null;
    }

    const packageDir = join(tmpDir, "package");
    const binaryName = provider;
    const candidates = [join(packageDir, "cli.mjs"), join(packageDir, "bin", binaryName), join(packageDir, binaryName)];

    let sourceBinary: string | null = null;
    for (const c of candidates) {
      if (existsSync(c)) {
        sourceBinary = c;
        break;
      }
    }

    if (!sourceBinary) {
      deps.error(`registry: no binary found in package (checked: ${candidates.join(", ")})`);
      return null;
    }

    const binaryDest = join(destDir, binaryName);
    const file = Bun.file(sourceBinary);
    await Bun.write(binaryDest, file);

    chmodSync(binaryDest, 0o755);

    const hash = await sha256File(binaryDest);
    deps.error(`registry: installed ${binaryDest} (sha256: ${hash})`);

    return { binaryPath: binaryDest, sha256: hash };
  } catch (err) {
    deps.error(`registry: failed: ${(err as Error).message}`);
    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Archive install (LFS) ──────────────────────────────────────────

export async function installFromArchive(
  entry: VersionEntry,
  provider: string,
  destDir: string,
  deps: InstallDeps,
): Promise<{ binaryPath: string; sha256: string }> {
  if (!entry.archive) {
    throw new Error(`No archive path in versions.yaml for ${provider}@${entry.version}`);
  }

  const archivePath = resolve(deps.gridDir, entry.archive);
  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath} — run 'git lfs pull' if this is a fresh clone`);
  }

  const expectedHash = readSidecarChecksum(archivePath);
  const actualHash = await sha256File(archivePath);

  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA256 mismatch for ${archivePath}\n  expected: ${expectedHash}\n  actual:   ${actualHash}\nArchive may be corrupted or tampered with.`,
    );
  }

  deps.error(`archive: checksum verified (${expectedHash})`);

  mkdirSync(destDir, { recursive: true });
  const extract = deps.spawn(["tar", "xzf", archivePath, "-C", destDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const extractExit = await extract.exited;
  if (extractExit !== 0) {
    const stderr = await new Response(extract.stderr).text();
    throw new Error(`Archive extraction failed (exit ${extractExit}): ${stderr.trim()}`);
  }

  const files = readdirSync(destDir);
  const binaryName =
    files.find((f) => f === `${provider}-${entry.version}`) ??
    files.find((f) => f === provider) ??
    files.find((f) => f.startsWith(provider) && !f.endsWith(".sha256"));

  if (!binaryName) {
    throw new Error(`No binary found after extracting archive (files: ${files.join(", ")})`);
  }

  const binaryPath = join(destDir, binaryName);

  chmodSync(binaryPath, 0o755);

  const binaryHash = await sha256File(binaryPath);
  deps.error(`archive: installed ${binaryPath} (binary sha256: ${binaryHash})`);

  return { binaryPath, sha256: binaryHash };
}

// ── Main ───────────────────────────────────────────────────────────

export async function installAgent(args: InstallArgs, deps: InstallDeps = defaultDeps): Promise<InstallResult> {
  const grid = loadGrid(deps.versionsPath);
  const entry = findVersionEntry(grid, args.provider, args.version);

  if (!entry) {
    const prov = grid.providers.find((p) => p.name === args.provider);
    if (!prov) {
      const known = grid.providers.map((p) => p.name).join(", ");
      throw new Error(`Unknown provider "${args.provider}" — known: ${known}`);
    }
    const versions = prov.versions.map((v) => v.version).join(", ");
    throw new Error(`Version "${args.version}" not found for ${args.provider} — known: ${versions || "(none)"}`);
  }

  const destDir = join(deps.agentsDir, args.provider, args.version);
  mkdirSync(destDir, { recursive: true });

  // Registry-first (skip if --offline)
  if (!args.offline) {
    deps.error(`Trying registry for ${args.provider}@${args.version}...`);
    const registryResult = await installFromRegistry(args.provider, args.version, destDir, deps);
    if (registryResult) {
      return {
        provider: args.provider,
        version: args.version,
        binaryPath: registryResult.binaryPath,
        source: "registry",
        sha256: registryResult.sha256,
      };
    }
    deps.error("Registry install failed — falling back to archive...");
  }

  // Archive fallback
  deps.error(`Installing ${args.provider}@${args.version} from archive...`);
  const archiveResult = await installFromArchive(entry, args.provider, destDir, deps);

  return {
    provider: args.provider,
    version: args.version,
    binaryPath: archiveResult.binaryPath,
    source: "archive",
    sha256: archiveResult.sha256,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.error("Usage: install-agent [--offline] <provider@version>");
    console.error("");
    console.error("Install an agent provider binary, verified by sha256 checksum.");
    console.error("");
    console.error("Options:");
    console.error("  --offline    Install from LFS archive only (no network)");
    console.error("");
    console.error("Examples:");
    console.error("  install-agent claude@2.1.119");
    console.error("  install-agent --offline claude@2.1.119");
    process.exit(argv.length === 0 ? 1 : 0);
  }

  try {
    const args = parseInstallAgentArgs(argv);
    const result = await installAgent(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
