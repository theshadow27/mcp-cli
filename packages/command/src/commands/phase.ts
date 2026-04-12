/**
 * `mcx phase` — declarative phase orchestration.
 *
 * Subcommands:
 *   - `install` (#1291): resolves sources in the manifest, hashes them,
 *     extracts phase metadata, writes `.mcx.lock`.
 *   - `run <target>` (#1293): validates the transition against the manifest
 *     graph, appends it to `.mcx/transitions.jsonl`, prints "approved".
 *   - `list`: prints all declared phases from the manifest.
 *
 * Three typed errors for `run` (see `phase-transition.ts`):
 *   - UnknownPhaseError       (always fatal; --force cannot bypass)
 *   - DisallowedTransitionError
 *   - RegressionError
 */

import { renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import {
  DisallowedTransitionError,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  type LockedPhase,
  type Lockfile,
  type Manifest,
  ManifestError,
  type ManifestState,
  RegressionError,
  UnknownPhaseError,
  appendTransitionLog,
  bundleAlias,
  canonicalJson,
  extractMetadata,
  hashFileSync,
  historyTargets,
  loadManifest,
  readTransitionHistory,
  serializeLockfile,
  sha256Hex,
  validateTransition,
} from "@mcp-cli/core";
import type { AliasMetadata } from "@mcp-cli/core";
import { printError } from "../output";

export interface PhaseInstallDeps {
  loadManifest: typeof loadManifest;
  bundleAlias: typeof bundleAlias;
  extractMetadata: typeof extractMetadata;
  hashFileSync: typeof hashFileSync;
  writeFileSync: typeof writeFileSync;
  cwd: () => string;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  exit: (code: number) => never;
}

const defaultDeps: PhaseInstallDeps = {
  loadManifest,
  bundleAlias,
  extractMetadata,
  hashFileSync,
  writeFileSync: (path, data) => writeFileSync(path, data, "utf-8"),
  cwd: () => process.cwd(),
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
  exit: (code) => process.exit(code),
};

/**
 * Resolve a phase `source:` URI into an absolute path.
 * v1 supports `./relative`, bare relative, absolute, and `file://` forms.
 * Remote schemes (#1297) are rejected with an actionable message.
 */
export function resolvePhaseSource(source: string, repoRoot: string): string {
  if (source.startsWith("file://")) {
    const rest = source.slice("file://".length);
    const path = rest.startsWith("/") ? rest : `/${rest}`;
    return resolvePath(path);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new Error(`remote sources not yet supported: ${source}`);
  }
  return isAbsolute(source) ? resolvePath(source) : resolvePath(repoRoot, source);
}

/**
 * Compare a phase's declared state schema (as extracted from defineAlias)
 * against the manifest's state declaration. The phase may narrow, never
 * widen: every key it declares must exist in the manifest's `state:`.
 */
export function checkStateSubset(
  phaseName: string,
  phaseState: Record<string, unknown> | undefined,
  manifestState: ManifestState | undefined,
): string[] {
  if (!phaseState) return [];
  const allowed = new Set(Object.keys(manifestState ?? {}));
  const errors: string[] = [];
  for (const key of Object.keys(phaseState)) {
    if (!allowed.has(key)) {
      errors.push(`phase "${phaseName}" declares state field "${key}" not present in manifest state schema`);
    }
  }
  return errors;
}

interface InstallResult {
  manifest: Manifest;
  manifestPath: string;
  lockfile: Lockfile;
  warnings: string[];
}

export async function installPhases(cwd: string, deps: PhaseInstallDeps): Promise<InstallResult> {
  const loaded = deps.loadManifest(cwd);
  if (!loaded) {
    throw new Error("no .mcx.yaml or .mcx.json in this repo");
  }

  const { path: manifestPath, manifest } = loaded;
  const manifestHash = deps.hashFileSync(manifestPath);

  const warnings: string[] = [];
  const errors: string[] = [];
  const phases: LockedPhase[] = [];

  const phaseNames = Object.keys(manifest.phases).sort();
  for (const name of phaseNames) {
    const phase = manifest.phases[name];
    let resolvedAbs: string;
    try {
      resolvedAbs = resolvePhaseSource(phase.source, cwd);
    } catch (err) {
      errors.push(`phase "${name}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let contentHash: string;
    try {
      contentHash = deps.hashFileSync(resolvedAbs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT") {
        errors.push(`phase "${name}": source ${phase.source} not found`);
      } else {
        errors.push(`phase "${name}": cannot read ${phase.source}: ${e?.message ?? String(err)}`);
      }
      continue;
    }

    let meta: AliasMetadata;
    try {
      const bundle = await deps.bundleAlias(resolvedAbs);
      meta = await deps.extractMetadata(bundle.js);
    } catch (err) {
      errors.push(`phase "${name}": bundle failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const subsetErrs = checkStateSubset(name, undefined, manifest.state);
    if (subsetErrs.length > 0) {
      errors.push(...subsetErrs);
      continue;
    }

    const schemaHash = meta.outputSchema ? sha256Hex(canonicalJson(meta.outputSchema)) : "";
    const rel = relative(cwd, resolvedAbs).split("\\").join("/");
    phases.push({
      name,
      resolvedPath: rel === "" ? "." : rel,
      contentHash,
      schemaHash,
    });
  }

  if (errors.length > 0) {
    errors.sort();
    throw new ManifestError(errors.join("\n"), manifestPath);
  }

  const lockfile: Lockfile = {
    version: LOCKFILE_VERSION,
    manifestHash,
    phases,
  };

  return { manifest, manifestPath, lockfile, warnings };
}

export interface PhaseRunOptions {
  target: string;
  from: string | null;
  workItemId: string | null;
  forceMessage: string | null;
}

export interface PhaseRunDeps {
  cwd: string;
  now?: () => Date;
}

export function parsePhaseRunArgs(args: string[]): PhaseRunOptions {
  let target: string | null = null;
  let from: string | null = null;
  let workItemId: string | null = null;
  let forceSeen = false;
  let forceMessage: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from") {
      from = args[++i] ?? null;
      if (from === null) throw new Error("--from requires a phase name");
    } else if (a.startsWith("--from=")) {
      from = a.slice("--from=".length);
    } else if (a === "--work-item") {
      workItemId = args[++i] ?? null;
      if (workItemId === null) throw new Error("--work-item requires an id");
    } else if (a.startsWith("--work-item=")) {
      workItemId = a.slice("--work-item=".length);
    } else if (a === "--force") {
      forceSeen = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        forceMessage = next;
        i++;
      }
    } else if (a.startsWith("--force=")) {
      forceSeen = true;
      forceMessage = a.slice("--force=".length);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (target === null) {
      target = a;
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }

  if (target === null) {
    throw new Error("Usage: mcx phase run <target> [--from <current>] [--work-item <id>] [--force <message>]");
  }
  if (forceSeen && (forceMessage === null || forceMessage.trim() === "")) {
    throw new Error("--force requires a non-empty justification message");
  }
  return { target, from, workItemId, forceMessage: forceSeen ? (forceMessage as string) : null };
}

export function transitionLogPath(repoDir: string): string {
  return join(repoDir, ".mcx", "transitions.jsonl");
}

export function phaseRun(
  options: PhaseRunOptions,
  deps: PhaseRunDeps,
): { manifest: Manifest; forced: boolean; from: string | null } {
  const loaded = loadManifest(deps.cwd);
  if (!loaded) {
    throw new ManifestError("no .mcx.yaml or .mcx.json in this repo", deps.cwd);
  }
  const { path: manifestPath, manifest } = loaded;

  const logPath = transitionLogPath(deps.cwd);
  const history = historyTargets(readTransitionHistory(logPath, options.workItemId));

  let from = options.from;
  if (from === null && history.length > 0) {
    from = history[history.length - 1];
  }

  const decision = validateTransition({
    manifest,
    from,
    target: options.target,
    history,
    workItemId: options.workItemId,
    force: options.forceMessage !== null ? { message: options.forceMessage } : null,
    manifestPath,
  });

  const now = deps.now?.() ?? new Date();
  appendTransitionLog(logPath, {
    ts: now.toISOString(),
    workItemId: options.workItemId,
    from: decision.from,
    to: decision.target,
    ...(options.forceMessage !== null ? { forceMessage: options.forceMessage } : {}),
  });

  return { manifest, forced: decision.forced, from: decision.from };
}

export async function cmdPhase(args: string[], deps?: Partial<PhaseInstallDeps>): Promise<void> {
  const d: PhaseInstallDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printPhaseHelp(d);
    return;
  }

  try {
    if (sub === "install") {
      const cwd = d.cwd();
      let result: InstallResult;
      try {
        result = await installPhases(cwd, d);
      } catch (err) {
        if (err instanceof ManifestError) {
          d.logError(err.message);
        } else {
          d.logError(err instanceof Error ? err.message : String(err));
        }
        d.exit(1);
      }

      const lockPath = resolvePath(cwd, LOCKFILE_NAME);
      const tmpPath = `${lockPath}.tmp`;
      d.writeFileSync(tmpPath, serializeLockfile(result.lockfile));
      renameSync(tmpPath, lockPath);

      const count = result.lockfile.phases.length;
      d.log(`Installed ${count} phase${count === 1 ? "" : "s"} → ${LOCKFILE_NAME}`);
      for (const p of result.lockfile.phases) {
        d.log(`  ${p.name}  ${p.resolvedPath}  ${p.contentHash.slice(0, 12)}`);
      }
      for (const w of result.warnings) {
        d.logError(`  ⚠ ${w}`);
      }
      d.logError(
        "note: scope registration (#1289) and state-schema subset (#1290) are deferred — lockfile written, aliases not yet scoped.",
      );
      return;
    }

    if (sub === "list") {
      const loaded = loadManifest(d.cwd());
      if (!loaded) {
        printError("no .mcx.yaml or .mcx.json in this repo");
        d.exit(1);
      }
      for (const name of Object.keys(loaded.manifest.phases).sort()) {
        d.log(name);
      }
      return;
    }

    if (sub === "run") {
      const opts = parsePhaseRunArgs(args.slice(1));
      const result = phaseRun(opts, { cwd: d.cwd() });
      const source = result.manifest.phases[opts.target]?.source ?? "(unknown)";
      const tag = result.forced ? " [FORCED]" : "";
      const trail = result.from ?? "(initial)";
      d.logError(`approved${tag}: ${trail} → ${opts.target} (${source})`);
      return;
    }

    printError(`Unknown subcommand: ${sub}`);
    printPhaseHelp(d);
    d.exit(1);
  } catch (err) {
    if (
      err instanceof UnknownPhaseError ||
      err instanceof DisallowedTransitionError ||
      err instanceof RegressionError
    ) {
      printError(err.message);
      d.exit(1);
    }
    if (err instanceof ManifestError) {
      printError(`${err.path}: ${err.message}`);
      d.exit(1);
    }
    if (err instanceof Error) {
      printError(err.message);
      d.exit(1);
    }
    throw err;
  }
}

function printPhaseHelp(d: PhaseInstallDeps): void {
  d.log(`mcx phase — orchestration phase graph

Subcommands:
  mcx phase install
      Resolve sources from .mcx.{yaml,json}, hash, write .mcx.lock.

  mcx phase run <target> [--from <current>] [--work-item <id>] [--force <message>]
      Validate and record a phase transition against .mcx.{yaml,json}.
      --force <message> bypasses disallowed-transition and regression checks;
      unknown-phase errors are never bypassable.

  mcx phase list
      List all phases declared in the manifest.`);
}
