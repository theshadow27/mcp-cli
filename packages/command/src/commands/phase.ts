/**
 * `mcx phase` — declarative phase orchestration (#1286).
 *
 * Currently implements `install`: resolves sources in the manifest,
 * hashes them, extracts phase metadata, writes `.mcx.lock`.
 *
 * Scope registration (#1289) and state-schema subset validation (#1290)
 * are deferred until their dependency PRs merge.
 */

import { renameSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  type LockedPhase,
  type Lockfile,
  type Manifest,
  ManifestError,
  type ManifestState,
  bundleAlias,
  canonicalJson,
  extractMetadata,
  hashFileSync,
  loadManifest,
  serializeLockfile,
  sha256Hex,
} from "@mcp-cli/core";
import type { AliasMetadata } from "@mcp-cli/core";

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
 *
 * v1 uses the manifest state DSL (`string`/`number`/`boolean`[?]) as the
 * authoritative key-set. When defineAlias gains a `state` field (#1290),
 * the extractor will surface it here.
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

    // state field wires in with #1290 — no-op until AliasMetadata carries it
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

export async function cmdPhase(args: string[], deps?: Partial<PhaseInstallDeps>): Promise<void> {
  const d: PhaseInstallDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  switch (sub) {
    case "install": {
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
      break;
    }

    default: {
      printPhaseHelp(d);
      const isHelp = !sub || sub === "help" || sub === "--help" || sub === "-h";
      if (!isHelp) d.exit(1);
      break;
    }
  }
}

function printPhaseHelp(d: PhaseInstallDeps): void {
  d.logError(`Usage: mcx phase <command>

Commands:
  install    Resolve sources from .mcx.{yaml,json}, hash, write .mcx.lock
`);
}
