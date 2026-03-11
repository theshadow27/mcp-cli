#!/usr/bin/env bun
/**
 * Semantic version bump script for CI releases.
 *
 * Reads conventional commit messages since the last git tag,
 * determines the appropriate semver bump, updates package.json,
 * and prints the new version to stdout.
 *
 * Exit codes:
 *   0 — version bumped (new version printed to stdout)
 *   0 — no releasable commits (nothing printed)
 *   1 — error
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Commit prefixes that trigger a release */
const RELEASABLE_PREFIXES = new Set(["feat", "fix", "refactor", "perf", "build"]);

/** Commit prefixes that never trigger a release on their own */
const SKIP_PREFIXES = new Set(["test", "docs", "ci", "chore", "style", "release"]);

export interface ReleaseResult {
  /** New version string, or null if no release needed */
  version: string | null;
  /** Bump type applied */
  bump: "major" | "minor" | "patch" | null;
}

/**
 * Parse a conventional commit subject line to extract its prefix.
 * Handles formats like "feat:", "feat(scope):", "feat!:" (breaking).
 */
export function parseCommitPrefix(subject: string): { prefix: string; breaking: boolean } | null {
  const match = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s/);
  if (!match) return null;
  return { prefix: match[1], breaking: !!match[2] };
}

/**
 * Determine the semver bump level from a list of commit subjects.
 * Returns null if no releasable commits found.
 */
export function determineBump(subjects: string[], bodies: string[] = []): "major" | "minor" | "patch" | null {
  let hasBreaking = false;
  let hasFeat = false;
  let hasReleasable = false;

  for (let i = 0; i < subjects.length; i++) {
    const parsed = parseCommitPrefix(subjects[i]);
    if (!parsed) {
      // Non-conventional commit — skip, don't release for unstructured messages
      continue;
    }

    if (parsed.breaking) {
      hasBreaking = true;
      continue;
    }

    // Check commit body for BREAKING CHANGE
    if (bodies[i]?.includes("BREAKING CHANGE")) {
      hasBreaking = true;
    }

    if (parsed.prefix === "feat") {
      hasFeat = true;
    }

    if (RELEASABLE_PREFIXES.has(parsed.prefix)) {
      hasReleasable = true;
    }
    // Unknown prefix — skip, only explicit releasable prefixes trigger releases
  }

  if (hasBreaking) return "major";
  if (hasFeat) return "minor";
  if (hasReleasable) return "patch";
  return null;
}

/** Bump a semver string by the given level. */
export function bumpVersion(current: string, level: "major" | "minor" | "patch"): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: ${current}`);
  }
  const [major, minor, patch] = parts;
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Get the last git tag, or null if none exist. */
async function getLastTag(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "describe", "--tags", "--abbrev=0"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return null;
    const tag = (await new Response(proc.stdout).text()).trim();
    return tag || null;
  } catch {
    return null;
  }
}

/** Get commit subjects since a ref (or all commits if ref is null). */
async function getCommitsSince(ref: string | null): Promise<{ subjects: string[]; bodies: string[] }> {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  // Use %x00 as delimiter between subject and body, %x01 between commits
  const format = "%s%x00%b%x01";
  const args = ["git", "log", range, `--format=${format}`];
  // Cap history scan when no prior tag exists to avoid reading entire repo
  if (!ref) args.push("--max-count=100");
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const output = (await new Response(proc.stdout).text()).trim();
  if (!output) return { subjects: [], bodies: [] };

  const commits = output.split("\x01").filter(Boolean);
  const subjects: string[] = [];
  const bodies: string[] = [];
  for (const commit of commits) {
    const [subject, ...bodyParts] = commit.split("\x00");
    subjects.push(subject.trim());
    bodies.push(bodyParts.join("\x00").trim());
  }
  return { subjects, bodies };
}

/**
 * Main release logic. Exported for testing.
 */
export async function release(packageJsonPath?: string): Promise<ReleaseResult> {
  const pkgPath = packageJsonPath ?? resolve("package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const currentVersion: string = pkg.version;

  const lastTag = await getLastTag();
  const { subjects, bodies } = await getCommitsSince(lastTag);

  if (subjects.length === 0) {
    return { version: null, bump: null };
  }

  const bump = determineBump(subjects, bodies);
  if (!bump) {
    return { version: null, bump: null };
  }

  const newVersion = bumpVersion(currentVersion, bump);

  // Update package.json
  pkg.version = newVersion;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  return { version: newVersion, bump };
}

// CLI entry point
if (import.meta.main) {
  const createTag = process.argv.includes("--tag");
  try {
    const result = await release();
    if (result.version) {
      // Print version to stdout for CI consumption
      console.log(result.version);
      // Log bump type to stderr for human debugging
      console.error(`Bumped ${result.bump}: ${result.version}`);

      if (createTag) {
        const tag = `v${result.version}`;
        const tagProc = Bun.spawn(["git", "tag", tag], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const tagCode = await tagProc.exited;
        if (tagCode !== 0) {
          const stderr = await new Response(tagProc.stderr).text();
          throw new Error(`Failed to create tag ${tag}: ${stderr.trim()}`);
        }
        console.error(`Created tag: ${tag}`);
      }
    } else {
      console.error("No releasable commits since last tag — skipping release");
    }
  } catch (err) {
    console.error("Release failed:", err);
    process.exit(1);
  }
}
