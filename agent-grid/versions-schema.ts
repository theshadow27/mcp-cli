/**
 * Zod v4 schema for `agent-grid/versions.yaml`.
 *
 * Validates the versioned source of truth for (provider × version) test
 * outcomes. Used by `scripts/validate-agent-grid.ts` (wired into am-i-done)
 * and downstream grid tooling.
 */

import { z } from "zod";

const PROVIDER_NAMES = ["claude", "codex", "grok", "copilot", "gemini", "opencode", "acp", "mock"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const TRACK_VALUES = ["patch", "minor", "major"] as const;

const OUTCOME_VALUES = ["untested", "pass", "fail", "fail-wontfix", "flake"] as const;
export type Outcome = (typeof OUTCOME_VALUES)[number];

const FAILURE_CLASSES = ["spawn-failed", "protocol-broken", "runtime-broken", "flake", "quota", "wontfix"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const iso8601 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "must be ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ)");

export const VersionEntrySchema = z
  .object({
    version: z.string().min(1, "version must be non-empty"),
    first_seen: iso8601.optional(),
    last_tested: iso8601.optional(),
    outcome: z.enum(OUTCOME_VALUES),
    recording: z.string().optional(),
    archive: z.string().optional(),
    binary_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "must be a 64-char hex sha256 hash")
      .optional(),
    failure_class: z.enum(FAILURE_CLASSES).optional(),
    reason: z.string().optional(),
    issue: z.number().int().positive().optional(),
  })
  .refine(
    (v) => {
      if (v.outcome === "fail" || v.outcome === "fail-wontfix" || v.outcome === "flake") {
        return v.failure_class !== undefined;
      }
      return true;
    },
    { message: "failure_class is required when outcome is fail, fail-wontfix, or flake" },
  )
  .refine(
    (v) => {
      if (v.outcome === "pass") {
        return v.failure_class === undefined;
      }
      return true;
    },
    { message: "failure_class must not be set when outcome is pass" },
  )
  .refine(
    (v) => {
      if (v.outcome === "untested") {
        return v.failure_class === undefined;
      }
      return true;
    },
    { message: "failure_class must not be set when outcome is untested" },
  );

export type VersionEntry = z.infer<typeof VersionEntrySchema>;

export const ProviderSchema = z.object({
  name: z.enum(PROVIDER_NAMES),
  track: z.enum(TRACK_VALUES),
  enabled: z.boolean().default(true),
  versions: z.array(VersionEntrySchema).default([]),
});

export type Provider = z.infer<typeof ProviderSchema>;

export const VersionsGridSchema = z.object({
  providers: z.array(ProviderSchema).min(1, "at least one provider required"),
});

export type VersionsGrid = z.infer<typeof VersionsGridSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warn";
}

export type ValidationResult =
  | { ok: true; grid: VersionsGrid; issues: ValidationIssue[] }
  | { ok: false; grid?: undefined; issues: ValidationIssue[] };

function isTraversalPath(p: string): boolean {
  return p.startsWith("/") || p.includes("..") || p.startsWith("~");
}

export function validateVersionsGrid(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  const result = VersionsGridSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      issues.push({ path: where, message: issue.message, severity: "error" });
    }
    return { ok: false, issues };
  }

  const grid = result.data;
  const seenProviders = new Set<string>();

  for (let pi = 0; pi < grid.providers.length; pi++) {
    const provider = grid.providers[pi] as Provider;
    const pPath = `providers[${pi}]`;

    if (seenProviders.has(provider.name)) {
      issues.push({ path: `${pPath}.name`, message: `duplicate provider "${provider.name}"`, severity: "error" });
    }
    seenProviders.add(provider.name);

    if (!provider.enabled && provider.versions.length > 0) {
      issues.push({
        path: `${pPath}`,
        message: `disabled provider "${provider.name}" has version entries — remove them or re-enable`,
        severity: "warn",
      });
    }

    const seenVersions = new Set<string>();
    for (let vi = 0; vi < provider.versions.length; vi++) {
      const version = provider.versions[vi] as VersionEntry;
      const vPath = `${pPath}.versions[${vi}]`;

      if (seenVersions.has(version.version)) {
        issues.push({
          path: `${vPath}.version`,
          message: `duplicate version "${version.version}" in provider "${provider.name}"`,
          severity: "error",
        });
      }
      seenVersions.add(version.version);

      if (version.recording && isTraversalPath(version.recording)) {
        issues.push({
          path: `${vPath}.recording`,
          message: `recording path must be relative within agent-grid/: ${version.recording}`,
          severity: "error",
        });
      }

      if (version.archive && isTraversalPath(version.archive)) {
        issues.push({
          path: `${vPath}.archive`,
          message: `archive path must be relative within agent-grid/: ${version.archive}`,
          severity: "error",
        });
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return hasErrors ? { ok: false, issues } : { ok: true, grid, issues };
}
