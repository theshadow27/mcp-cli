#!/usr/bin/env bun
/**
 * Detect latest versions from provider registries and propose new
 * `versions.yaml` rows for human review. Read-only — never writes
 * or commits.
 *
 * Usage: bun scripts/agent-grid-detect.ts [--json]
 *
 * Exit 0: proposed rows printed (or nothing new).
 * Exit 1: one or more registry queries failed.
 * Exit 2: versions.yaml unreadable or invalid.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Provider,
  type ProviderName,
  type VersionEntry,
  validateVersionsGrid,
} from "../agent-grid/versions-schema";

// ── Registry map ──────────────────────────────────────────────────

export interface RegistryEntry {
  npm: string;
}

export const REGISTRY: Partial<Record<ProviderName, RegistryEntry>> = {
  claude: { npm: "@anthropic-ai/claude-code" },
  codex: { npm: "@openai/codex" },
  opencode: { npm: "opencode-ai" },
};

// ── Semver helpers ────────────────────────────────────────────────

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export function parseSemVer(v: string): SemVer | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1] as string, 10),
    minor: Number.parseInt(m[2] as string, 10),
    patch: Number.parseInt(m[3] as string, 10),
    prerelease: m[4] ?? "",
  };
}

export function matchesTrack(latest: SemVer, known: SemVer, track: "patch" | "minor" | "major"): boolean {
  switch (track) {
    case "patch":
      return latest.major === known.major && latest.minor === known.minor;
    case "minor":
      return latest.major === known.major;
    case "major":
      return true;
  }
}

// ── Registry query ────────────────────────────────────────────────

export interface QueryResult {
  provider: string;
  version: string;
  ok: true;
}

export interface QueryError {
  provider: string;
  error: string;
  ok: false;
}

const NPM_QUERY_TIMEOUT_MS = 15_000;

export function queryNpmVersion(pkg: string, spawner = spawnSync): string | null {
  const result = spawner("npm", ["view", pkg, "version"], {
    encoding: "utf-8" as BufferEncoding,
    timeout: NPM_QUERY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const version = (result.stdout as string).trim();
  return version || null;
}

// ── Core detection ────────────────────────────────────────────────

export interface ProposedRow {
  provider: string;
  track: string;
  entry: VersionEntry;
}

export function detectNewVersions(
  providers: Provider[],
  queryer: (pkg: string) => string | null = queryNpmVersion,
): {
  proposed: ProposedRow[];
  skipped: Array<{ provider: string; reason: string }>;
  errors: Array<{ provider: string; error: string }>;
} {
  const proposed: ProposedRow[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const errors: Array<{ provider: string; error: string }> = [];

  for (const provider of providers) {
    if (provider.enabled === false) {
      skipped.push({ provider: provider.name, reason: "disabled" });
      continue;
    }

    if (provider.name === "mock") {
      skipped.push({ provider: provider.name, reason: "mock provider — no registry" });
      continue;
    }

    const reg = REGISTRY[provider.name];
    if (!reg) {
      skipped.push({ provider: provider.name, reason: "no registry configured" });
      continue;
    }

    const latest = queryer(reg.npm);
    if (!latest) {
      errors.push({ provider: provider.name, error: `failed to query npm for ${reg.npm}` });
      continue;
    }

    const knownVersions = new Set(provider.versions.map((v) => v.version));
    if (knownVersions.has(latest)) {
      skipped.push({ provider: provider.name, reason: `${latest} already tracked` });
      continue;
    }

    const latestSemver = parseSemVer(latest);
    if (!latestSemver) {
      errors.push({ provider: provider.name, error: `cannot parse version "${latest}" as semver` });
      continue;
    }

    const existingVersions = provider.versions
      .map((v) => parseSemVer(v.version))
      .filter((v): v is SemVer => v !== null);

    const highestKnown =
      existingVersions.length > 0
        ? existingVersions.reduce((a, b) => {
            if (a.major !== b.major) return a.major > b.major ? a : b;
            if (a.minor !== b.minor) return a.minor > b.minor ? a : b;
            return a.patch > b.patch ? a : b;
          })
        : null;

    if (highestKnown && !matchesTrack(latestSemver, highestKnown, provider.track)) {
      skipped.push({
        provider: provider.name,
        reason: `${latest} outside ${provider.track} track (highest known: ${highestKnown.major}.${highestKnown.minor}.${highestKnown.patch})`,
      });
      continue;
    }

    const now = new Date();
    const isoNow = `${now.toISOString().replace(/\.\d{3}Z$/, "Z")}`;

    proposed.push({
      provider: provider.name,
      track: provider.track,
      entry: {
        version: latest,
        first_seen: isoNow,
        outcome: "untested",
      },
    });
  }

  return { proposed, skipped, errors };
}

// ── Output formatting ─────────────────────────────────────────────

export function formatYaml(rows: ProposedRow[]): string {
  const lines: string[] = [];
  lines.push("# Proposed new versions.yaml rows");
  lines.push("# Review and merge into agent-grid/versions.yaml");
  lines.push("");
  for (const row of rows) {
    lines.push(`# provider: ${row.provider} (track: ${row.track})`);
    lines.push(`      - version: "${row.entry.version}"`);
    if (row.entry.first_seen) lines.push(`        first_seen: "${row.entry.first_seen}"`);
    lines.push(`        outcome: ${row.entry.outcome}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatJson(rows: ProposedRow[]): string {
  return JSON.stringify(rows, null, 2);
}

// ── Main ──────────────────────────────────────────────────────────

function main(): void {
  const jsonMode = process.argv.includes("--json");

  const repoRoot = resolve(import.meta.dir, "..");
  const versionsPath = resolve(repoRoot, "agent-grid", "versions.yaml");

  let text: string;
  try {
    text = readFileSync(versionsPath, "utf-8");
  } catch (err) {
    process.stderr.write(`error: cannot read ${versionsPath}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    process.stderr.write(`error: invalid YAML: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const validation = validateVersionsGrid(raw);
  if (!validation.ok) {
    process.stderr.write("error: versions.yaml is invalid:\n");
    for (const issue of validation.issues) {
      process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
    }
    process.exit(2);
  }

  const { proposed, skipped, errors } = detectNewVersions(validation.grid.providers);

  for (const s of skipped) {
    process.stderr.write(`skip: ${s.provider}: ${s.reason}\n`);
  }
  for (const e of errors) {
    process.stderr.write(`error: ${e.provider}: ${e.error}\n`);
  }

  if (proposed.length === 0) {
    process.stderr.write("no new versions detected\n");
    process.exit(errors.length > 0 ? 1 : 0);
  }

  process.stderr.write(`\n${proposed.length} new version${proposed.length === 1 ? "" : "s"} detected:\n`);
  for (const p of proposed) {
    process.stderr.write(`  ${p.provider} ${p.entry.version}\n`);
  }
  process.stderr.write("\n");

  if (jsonMode) {
    process.stdout.write(`${formatJson(proposed)}\n`);
  } else {
    process.stdout.write(formatYaml(proposed));
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
