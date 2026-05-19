/**
 * mcx track/untrack/tracked — work item tracking commands.
 *
 * Track:   mcx track <number>           Track an issue/PR by number
 *          mcx track --branch <name>    Track a branch
 * Untrack: mcx untrack <number>         Stop tracking by number
 *          mcx untrack --branch <name>  Stop tracking by branch
 * List:    mcx tracked                  Human-readable table
 *          mcx tracked --json           Machine-readable output
 */

import type { IpcMethod, IpcMethodResult, Manifest, TrackableField, WorkItem, WorkItemPhase } from "@mcp-cli/core";
import {
  ManifestVersionError,
  WORK_ITEM_PHASES,
  coerceTrackValue,
  getTrackableFields,
  ipcCall,
  loadManifest,
  validateTrackValue,
} from "@mcp-cli/core";
import { c, printError } from "../output";

/** Load a manifest from the given directory, swallowing parse errors so they don't break CLI commands. */
function tryLoadManifest(dir: string): Manifest | null {
  try {
    return loadManifest(dir)?.manifest ?? null;
  } catch (err) {
    if (err instanceof ManifestVersionError) throw err;
    return null;
  }
}

export interface TrackDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  exit: (code: number) => never;
  loadManifest?: (dir: string) => Manifest | null;
  /** Override `process.cwd()` for testing — avoids process.chdir() in tests. */
  cwd?: () => string;
}

const defaultDeps: TrackDeps = {
  ipcCall,
  exit: (code) => process.exit(code),
  loadManifest: tryLoadManifest,
};

/** Built-in flags that are not metadata fields (covers both cmdTrack and cmdTracked). */
const BUILTIN_FLAGS = new Set(["--branch", "--automation", "--help", "-h", "--phase", "--json"]);

/**
 * Parse metadata flags from args based on trackable fields declared in manifest.
 * Returns parsed metadata and the set of arg indices consumed by metadata flags.
 */
export function parseMetadataFlags(
  args: string[],
  trackableFields: TrackableField[],
): { metadata: Map<string, string | number | boolean>; consumed: Set<number>; errors: string[] } {
  const fieldMap = new Map(trackableFields.map((f) => [f.key, f]));
  const metadata = new Map<string, string | number | boolean>();
  const consumed = new Set<number>();
  const errors: string[] = [];
  const repeatableAccum = new Map<string, string[]>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--") || BUILTIN_FLAGS.has(arg)) continue;

    const flagName = arg.slice(2).replace(/-/g, "_");
    const field = fieldMap.get(flagName);

    if (!field) {
      if (!fieldMap.size) continue;
      const known = trackableFields.map((f) => `--${f.key.replace(/_/g, "-")}`);
      errors.push(`unknown metadata flag "${arg}"; declared fields: ${known.join(", ")}`);
      continue;
    }

    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${arg} requires a value`);
      continue;
    }

    const validationError = validateTrackValue(field, value);
    if (validationError) {
      errors.push(validationError);
      consumed.add(i);
      consumed.add(i + 1);
      i++;
      continue;
    }

    consumed.add(i);
    consumed.add(i + 1);

    if (field.repeatable) {
      const accum = repeatableAccum.get(field.key) ?? [];
      accum.push(value);
      repeatableAccum.set(field.key, accum);
    } else {
      metadata.set(field.key, coerceTrackValue(field, value));
    }
    i++;
  }

  for (const [key, values] of repeatableAccum) {
    metadata.set(key, values.join(","));
  }

  for (const field of trackableFields) {
    if (field.required && !metadata.has(field.key) && field.defaultValue === undefined) {
      errors.push(`required metadata field --${field.key.replace(/_/g, "-")} is missing`);
    }
  }

  return { metadata, consumed, errors };
}

// -- mcx track --

export async function cmdTrack(args: string[], deps: TrackDeps = defaultDeps): Promise<void> {
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const manifest = (deps.loadManifest ?? tryLoadManifest)(cwd);
  const trackableFields = getTrackableFields(manifest?.state);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printTrackHelp(trackableFields);
    return;
  }

  const initialPhase = manifest?.initial;

  const automationIdx = args.indexOf("--automation");
  let automationOverrides: string | undefined;
  if (automationIdx >= 0) {
    automationOverrides = args[automationIdx + 1];
    if (!automationOverrides || automationOverrides.startsWith("--")) {
      printError("--automation requires a value (e.g. merge=false,bind=true)");
      return deps.exit(1);
    }
  }

  const { metadata, consumed: metaConsumed, errors: metaErrors } = parseMetadataFlags(args, trackableFields);
  if (metaErrors.length > 0) {
    for (const err of metaErrors) printError(err);
    return deps.exit(1);
  }

  const branchIdx = args.indexOf("--branch");
  if (branchIdx >= 0) {
    const branch = args[branchIdx + 1];
    if (!branch || branch.startsWith("--")) {
      printError("Usage: mcx track --branch <name>");
      return deps.exit(1);
    }
    try {
      const item = await deps.ipcCall("trackWorkItem", {
        branch,
        ...(initialPhase ? { initialPhase } : {}),
        ...(automationOverrides ? { automationOverrides } : {}),
        repoRoot: cwd,
      });
      await persistMetadata(deps, cwd, item.id, metadata, trackableFields);
      console.error(`Tracking branch ${branch} (${item.id})`);
    } catch (err) {
      printError(`Failed to track branch: ${err instanceof Error ? err.message : String(err)}`);
      return deps.exit(1);
    }
    return;
  }

  const skipIndices = new Set<number>();
  if (automationIdx >= 0) {
    skipIndices.add(automationIdx);
    skipIndices.add(automationIdx + 1);
  }
  for (const idx of metaConsumed) skipIndices.add(idx);

  const firstPositional = args.find((_, i) => !skipIndices.has(i) && !args[i].startsWith("--"));
  const num = Number(firstPositional);
  if (!firstPositional || !Number.isInteger(num) || num <= 0) {
    printError(`Invalid number: ${firstPositional ?? args[0]}`);
    return deps.exit(1);
  }

  try {
    const item = await deps.ipcCall("trackWorkItem", {
      number: num,
      ...(initialPhase ? { initialPhase } : {}),
      ...(automationOverrides ? { automationOverrides } : {}),
      repoRoot: cwd,
    });
    await persistMetadata(deps, cwd, item.id, metadata, trackableFields);
    console.error(`Tracking #${num} (${item.id})`);
  } catch (err) {
    printError(`Failed to track #${num}: ${err instanceof Error ? err.message : String(err)}`);
    return deps.exit(1);
  }
}

async function persistMetadata(
  deps: TrackDeps,
  repoRoot: string,
  workItemId: string,
  metadata: Map<string, string | number | boolean>,
  trackableFields: TrackableField[],
): Promise<void> {
  if (metadata.size === 0 && !trackableFields.some((f) => f.defaultValue !== undefined)) return;
  const ns = `workitem:${workItemId}`;
  let existingState: Record<string, unknown> = {};
  try {
    const { entries } = await deps.ipcCall("aliasStateAll", { repoRoot, namespace: ns });
    existingState = entries;
  } catch {
    // No existing state — all defaults are safe to apply.
  }
  for (const field of trackableFields) {
    const explicit = metadata.get(field.key);
    if (explicit !== undefined) {
      await deps.ipcCall("aliasStateSet", { repoRoot, namespace: ns, key: field.key, value: explicit });
    } else if (field.defaultValue !== undefined && !(field.key in existingState)) {
      await deps.ipcCall("aliasStateSet", { repoRoot, namespace: ns, key: field.key, value: field.defaultValue });
    }
  }
}

async function cleanupMetadata(deps: TrackDeps, cwd: string, workItemId: string): Promise<void> {
  const ns = `workitem:${workItemId}`;
  try {
    const { entries } = await deps.ipcCall("aliasStateAll", { repoRoot: cwd, namespace: ns });
    for (const key of Object.keys(entries)) {
      await deps.ipcCall("aliasStateDelete", { repoRoot: cwd, namespace: ns, key });
    }
  } catch {
    // Best-effort — don't fail untrack if cleanup fails.
  }
}

// -- mcx untrack --

export async function cmdUntrack(args: string[], deps: TrackDeps = defaultDeps): Promise<void> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage: mcx untrack <number|#NNNN|pr:NNNN>\n       mcx untrack --branch <name>\n       mcx untrack branch:<name>",
    );
    return;
  }

  const cwd = (deps.cwd ?? (() => process.cwd()))();

  if (args[0].startsWith("branch:")) {
    const branch = args[0].slice("branch:".length);
    if (!branch) {
      printError("Usage: mcx untrack branch:<name>");
      return deps.exit(1);
    }
    try {
      const result = await deps.ipcCall("untrackWorkItem", { branch });
      if (result.deleted) {
        await cleanupMetadata(deps, cwd, `branch:${branch}`);
        console.error(`Untracked branch ${branch}`);
      } else {
        console.error(`Branch ${branch} was not tracked`);
      }
    } catch (err) {
      printError(`Failed to untrack branch: ${err instanceof Error ? err.message : String(err)}`);
      return deps.exit(1);
    }
    return;
  }

  if (args[0] === "--branch") {
    const branch = args[1];
    if (!branch) {
      printError("Usage: mcx untrack --branch <name>");
      return deps.exit(1);
    }
    try {
      const result = await deps.ipcCall("untrackWorkItem", { branch });
      if (result.deleted) {
        await cleanupMetadata(deps, cwd, `branch:${branch}`);
        console.error(`Untracked branch ${branch}`);
      } else {
        console.error(`Branch ${branch} was not tracked`);
      }
    } catch (err) {
      printError(`Failed to untrack branch: ${err instanceof Error ? err.message : String(err)}`);
      return deps.exit(1);
    }
    return;
  }

  const raw = args[0].replace(/^#/, "").replace(/^pr:/, "");
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    printError(`Invalid number: ${args[0]}`);
    return deps.exit(1);
  }

  try {
    const result = await deps.ipcCall("untrackWorkItem", { number: num });
    if (result.deleted) {
      await cleanupMetadata(deps, cwd, `#${num}`);
      console.error(`Untracked #${num}`);
    } else {
      console.error(`#${num} was not tracked`);
    }
  } catch (err) {
    printError(`Failed to untrack #${num}: ${err instanceof Error ? err.message : String(err)}`);
    return deps.exit(1);
  }
}

// -- mcx tracked --

export async function cmdTracked(args: string[], deps: TrackDeps = defaultDeps): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: mcx tracked [--json] [--phase <phase>]");
    return;
  }

  const jsonFlag = args.includes("--json");
  const phaseIdx = args.indexOf("--phase");
  let phase: string | undefined;
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const manifest = (deps.loadManifest ?? tryLoadManifest)(cwd);
  const declaredPhases = manifest ? Object.keys(manifest.phases) : null;

  if (phaseIdx >= 0) {
    const raw = args[phaseIdx + 1];
    if (!raw || raw.startsWith("--")) {
      const valid = declaredPhases ?? WORK_ITEM_PHASES;
      printError(`--phase requires a value: ${valid.join(", ")}`);
      return deps.exit(1);
    }
    if (declaredPhases) {
      if (!declaredPhases.includes(raw)) {
        // Warn (don't fail) — this matches #1298's contract for manifest mode.
        console.error(`warning: phase "${raw}" is not declared in manifest (declared: ${declaredPhases.join(", ")})`);
      }
      phase = raw;
    } else {
      if (!WORK_ITEM_PHASES.includes(raw as WorkItemPhase)) {
        printError(`Unknown phase "${raw}". Valid phases: ${WORK_ITEM_PHASES.join(", ")}`);
        return deps.exit(1);
      }
      phase = raw;
    }
  }

  const trackableFields = getTrackableFields(manifest?.state);

  try {
    const items = await deps.ipcCall("listWorkItems", phase ? { phase } : {});

    if (jsonFlag) {
      const trackableKeys = new Set(trackableFields.map((f) => f.key));
      const annotatedItems = await Promise.all(
        items.map(async (it) => {
          const base = {
            ...it,
            phaseValid: declaredPhases ? declaredPhases.includes(it.phase) : WORK_ITEM_PHASES.includes(it.phase),
          };
          if (trackableKeys.size === 0) return base;
          try {
            const { entries } = await deps.ipcCall("aliasStateAll", { repoRoot: cwd, namespace: `workitem:${it.id}` });
            const state: Record<string, unknown> = {};
            for (const key of trackableKeys) {
              if (key in entries) state[key] = entries[key];
            }
            return Object.keys(state).length > 0 ? { ...base, state } : base;
          } catch {
            return base;
          }
        }),
      );
      console.log(JSON.stringify(annotatedItems, null, 2));
      return;
    }

    if (items.length === 0) {
      console.error("No tracked work items. Use `mcx track <number>` to start tracking.");
      return;
    }

    for (const item of items) {
      console.log(formatWorkItemRow(item));
    }
  } catch (err) {
    printError(`Failed to list work items: ${err instanceof Error ? err.message : String(err)}`);
    return deps.exit(1);
  }
}

// -- Formatting --

const CI_ICONS: Record<string, string> = {
  none: "-",
  pending: "\u23F3",
  running: "\u23F3",
  passed: "\u2713",
  failed: "\u2717",
};

const REVIEW_ICONS: Record<string, string> = {
  none: "none",
  pending: "pending",
  approved: "\u2713",
  changes_requested: "\u2717",
};

/** Format a single work item as a scannable row. */
export function formatWorkItemRow(item: WorkItem): string {
  const id = item.id.padEnd(10);
  const pr = item.prNumber ? `PR #${item.prNumber}` : "      ";
  const prPad = pr.padEnd(10);
  const ci = `CI ${CI_ICONS[item.ciStatus] ?? item.ciStatus}`;
  const ciPad = ci.padEnd(8);
  const review = `review: ${REVIEW_ICONS[item.reviewStatus] ?? item.reviewStatus}`;
  const reviewPad = review.padEnd(20);
  const phase = `phase: ${item.phase}`;
  const phasePad = phase.padEnd(14);
  const branch = item.branch ? `  ${c.dim}${item.branch}${c.reset}` : "";

  return `${c.cyan}${id}${c.reset}  ${prPad}  ${ciPad}  ${reviewPad}  ${phasePad}${branch}`;
}

function formatFieldType(field: TrackableField): string {
  if (field.baseType === "enum" && field.enumValues) {
    return field.enumValues.join("|");
  }
  return field.baseType;
}

function printTrackHelp(trackableFields: TrackableField[] = []): void {
  const lines = [
    "mcx track — work item tracking",
    "",
    "Usage:",
    "  mcx track <number>                        Track an issue/PR by number",
    "  mcx track --branch <name>                 Track a branch (PR may not exist yet)",
    "  mcx track <number> --automation <csv>     Set per-item automation overrides",
    "  mcx untrack <number>                      Stop tracking by number",
    "  mcx untrack --branch <name>               Stop tracking by branch",
    "  mcx tracked                               List all tracked work items",
    "  mcx tracked --json                        Machine-readable output",
    "  mcx tracked --phase <phase>               Filter by phase (impl, review, repair, qa, done)",
  ];

  if (trackableFields.length > 0) {
    lines.push("", "Metadata fields (declared in .mcx.yaml):");
    for (const f of trackableFields) {
      const flag = `--${f.key.replace(/_/g, "-")}`;
      const type = formatFieldType(f);
      const attrs: string[] = [];
      if (f.repeatable) attrs.push("repeatable");
      if (f.required) attrs.push("required");
      if (f.defaultValue !== undefined) attrs.push(`default: ${f.defaultValue}`);
      const suffix = attrs.length > 0 ? `  (${attrs.join(", ")})` : "";
      lines.push(`  ${flag.padEnd(30)} <${type}>${suffix}`);
    }
  }

  lines.push(
    "",
    "Examples:",
    "  mcx track 1135",
    "  mcx track --branch feat/new-feature",
    "  mcx track 1135 --automation merge=false,bind=true",
    "  mcx untrack 1135",
    "  mcx tracked --json",
  );

  if (trackableFields.length > 0) {
    const exampleField = trackableFields[0];
    const exampleFlag = `--${exampleField.key.replace(/_/g, "-")}`;
    const exampleValue = exampleField.enumValues?.[0] ?? "value";
    lines.push(`  mcx track 1135 ${exampleFlag} ${exampleValue}`);
  }

  console.log(lines.join("\n"));
}
