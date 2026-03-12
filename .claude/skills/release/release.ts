#!/usr/bin/env bun
/**
 * Automate the mechanical release steps:
 *   1. Update package.json version
 *   2. Commit "release: vX.Y.Z"
 *   3. Tag vX.Y.Z
 *   4. Push branch + tag
 *   5. Create GitHub release with notes
 *
 * Usage:
 *   bun .claude/skills/release/release.ts --version 0.3.1 --notes release-notes.md
 *   bun .claude/skills/release/release.ts --version 0.3.1 --notes release-notes.md --dry-run
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

interface ReleaseArgs {
  version: string;
  notesFile: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ReleaseArgs {
  let version = "";
  let notesFile = "";
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version" && argv[i + 1]) {
      version = argv[++i];
    } else if (arg === "--notes" && argv[i + 1]) {
      notesFile = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (!version) {
    throw new Error("--version is required");
  }

  if (!notesFile) {
    throw new Error("--notes is required");
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `version "${version}" is not valid semver (expected X.Y.Z)`,
    );
  }

  return { version, notesFile, dryRun };
}

function run(
  cmd: string[],
  opts?: { quiet?: boolean; allowFailure?: boolean },
): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0 && !opts?.allowFailure) {
    throw new Error(
      `Command failed: ${cmd.join(" ")}\n${stderr || stdout}`,
    );
  }
  if (!opts?.quiet && stdout) {
    console.error(stdout);
  }
  return { stdout, exitCode: result.exitCode };
}

function updatePackageJson(version: string): void {
  const pkgPath = resolve("package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw);
  const oldVersion = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.error(`package.json: ${oldVersion} → ${version}`);
}

function main(): void {
  let args: ReleaseArgs;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
  const { version, notesFile, dryRun } = args;
  const tag = `v${version}`;

  const notes = readFileSync(resolve(notesFile), "utf-8").trim();
  if (!notes) {
    console.error(`Error: notes file "${notesFile}" is empty`);
    process.exit(1);
  }

  // Guard: must be on main
  const { stdout: branch } = run(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { quiet: true },
  );
  if (branch !== "main") {
    throw new Error(`Must release from main, currently on: ${branch}`);
  }

  // Guard: working tree must be clean (ignore package.json for retry case)
  const { stdout: status } = run(["git", "status", "--porcelain"], {
    quiet: true,
  });
  const nonPkgChanges = status
    .split("\n")
    .filter((l) => l.trim() && !l.includes("package.json"));
  if (nonPkgChanges.length > 0) {
    throw new Error(
      `Working tree is dirty — commit or stash changes first:\n${status}`,
    );
  }

  console.error(`Releasing ${tag}${dryRun ? " (dry run)" : ""}…`);

  if (dryRun) {
    console.error("\nDry run — skipping all mutations.");
    console.error(
      `Would update package.json, commit, tag ${tag}, push, and create GitHub release.`,
    );
    return;
  }

  // 1. Update package.json (idempotent — skip if already at target version)
  const pkgPath = resolve("package.json");
  const currentPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (currentPkg.version === version) {
    console.error(`package.json already at ${version}, skipping update`);
  } else {
    updatePackageJson(version);
  }

  // 2. Commit (idempotent — skip if HEAD is already the release commit)
  const { stdout: headMsg } = run(
    ["git", "log", "-1", "--format=%s"],
    { quiet: true },
  );
  if (headMsg === `release: ${tag}`) {
    console.error(`Release commit already exists, skipping commit`);
  } else {
    run(["git", "add", "package.json"]);
    // --no-verify: release is a meta-operation, not a code change
    run(["git", "commit", "--no-verify", "-m", `release: ${tag}`]);
  }

  // 3. Tag (idempotent — skip if tag exists and points to HEAD)
  const { stdout: headSha } = run(["git", "rev-parse", "HEAD"], {
    quiet: true,
  });
  const { stdout: tagSha, exitCode: tagExitCode } = run(
    ["git", "rev-parse", `refs/tags/${tag}`],
    { quiet: true, allowFailure: true },
  );
  if (tagExitCode === 0 && tagSha === headSha) {
    console.error(`Tag ${tag} already exists at HEAD, skipping`);
  } else if (tagExitCode === 0 && tagSha !== headSha) {
    throw new Error(
      `Tag ${tag} exists but points to ${tagSha.slice(0, 8)}, not HEAD (${headSha.slice(0, 8)}). Delete the tag manually to retry.`,
    );
  } else {
    run(["git", "tag", tag]);
  }

  // 4. Push branch + tag
  run(["git", "push", "origin", branch, tag]);

  // 5. Create GitHub release (idempotent — skip if release already exists)
  const { exitCode: releaseExists } = run(
    ["gh", "release", "view", tag],
    { quiet: true, allowFailure: true },
  );
  if (releaseExists === 0) {
    console.error(`GitHub release ${tag} already exists, skipping`);
  } else {
    run([
      "gh",
      "release",
      "create",
      tag,
      "--title",
      tag,
      "--notes",
      notes,
    ]);
  }

  console.error(`\nReleased ${tag}`);
}

if (import.meta.main) {
  main();
}

export { parseArgs, updatePackageJson };
