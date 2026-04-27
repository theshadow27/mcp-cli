/**
 * `mcx phase` — declarative phase orchestration.
 *
 * Subcommands:
 *   - `install` (#1291): resolves sources in the manifest, hashes them,
 *     extracts phase metadata, writes `.mcx.lock`.
 *   - `run <target>` (#1293): validates the transition against the manifest
 *     graph, appends it to `.mcx/transitions.jsonl`, prints "approved".
 *   - `check` (#1292): detects drift between `.mcx.lock` and on-disk sources.
 *   - `list`: prints all declared phases from the manifest.
 *
 * Three typed errors for `run` (see `phase-transition.ts`):
 *   - UnknownPhaseError       (always fatal; --force cannot bypass)
 *   - DisallowedTransitionError
 *   - RegressionError
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import {
  type AliasContext,
  type AliasStateAccessor,
  type AliasWorkItemInfo,
  BranchGuardError,
  DisallowedTransitionError,
  GLOBAL_STATE_NAMESPACE,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  type LockedPhase,
  type Lockfile,
  type Manifest,
  ManifestError,
  type ManifestState,
  NO_REPO_ROOT,
  RegressionError,
  type TransitionLogEntry,
  UnknownPhaseError,
  type WorkItem,
  appendAttempt,
  bundleAlias,
  canonicalJson,
  checkRunsOn,
  commitTransition,
  createAliasCache,
  createAliasState,
  createEphemeralState,
  createMcpProxy,
  createWaitForEvent,
  executeAliasBundled,
  extractMetadata,
  findGitRoot,
  hashFileSync,
  historyTargets,
  ipcCall,
  isCommitted,
  isDefineAlias,
  isPhaseInCycle,
  loadManifest,
  parseLockfile,
  readAllTransitions,
  readTransitionHistory,
  serializeLockfile,
  sha256Hex,
  suggestPhases,
  validateTransition,
  wrapDryRunContext,
} from "@mcp-cli/core";
import type { AliasMetadata } from "@mcp-cli/core";
import type { ExecFn, ExecResult } from "@mcp-cli/core";
import { printError } from "../output";

export interface PhaseInstallDeps {
  loadManifest: typeof loadManifest;
  bundleAlias: typeof bundleAlias;
  extractMetadata: typeof extractMetadata;
  hashFileSync: typeof hashFileSync;
  writeFileSync: (path: string, data: string) => void;
  readFileSync: (path: string) => string;
  existsSync: (path: string) => boolean;
  readFile: (path: string) => Promise<string>;
  executeAliasBundled: typeof executeAliasBundled;
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
  readFileSync: (path) => readFileSync(path, "utf-8"),
  existsSync: (path) => existsSync(path),
  readFile: (path) => Bun.file(path).text(),
  executeAliasBundled,
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

export interface PhaseLogOptions {
  workItemId: string | null;
  forcedOnly: boolean;
  json: boolean;
}

export function parsePhaseLogArgs(args: string[]): PhaseLogOptions {
  let workItemId: string | null = null;
  let forcedOnly = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--work-item") {
      workItemId = args[++i] ?? null;
      if (!workItemId) throw new Error("--work-item requires a non-empty id");
    } else if (a.startsWith("--work-item=")) {
      workItemId = a.slice("--work-item=".length);
      if (!workItemId) throw new Error("--work-item requires a non-empty id");
    } else if (a === "--forced-only") {
      forcedOnly = true;
    } else if (a === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { workItemId, forcedOnly, json };
}

/** Apply filters from options; return newest-first. */
export function filterTransitionLog(
  entries: readonly TransitionLogEntry[],
  opts: { workItemId?: string | null; forcedOnly?: boolean },
): TransitionLogEntry[] {
  const out: TransitionLogEntry[] = [];
  for (const e of entries) {
    if (opts.workItemId !== undefined && opts.workItemId !== null && e.workItemId !== opts.workItemId) continue;
    if (opts.forcedOnly && !e.forceMessage) continue;
    out.push(e);
  }
  return out.reverse();
}

const NOTE_MAX_WIDTH = 60;

function truncateNote(s: string): string {
  return s.length > NOTE_MAX_WIDTH ? `${s.slice(0, NOTE_MAX_WIDTH - 1)}…` : s;
}

/** Render transition entries as a human-readable table, newest first. */
export function formatTransitionLog(entries: readonly TransitionLogEntry[]): string[] {
  const rows = entries.map((e) => [
    e.ts,
    e.workItemId ?? "—",
    `${e.from ?? "(initial)"} → ${e.to}`,
    truncateNote(e.forceMessage ? `FORCED: ${e.forceMessage}` : ""),
  ]);
  const headers = ["TIMESTAMP", "WORK-ITEM", "TRANSITION", "NOTE"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const out: string[] = [];
  const pad = (row: string[]) =>
    row
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  out.push(pad(headers));
  for (const r of rows) out.push(pad(r));
  return out;
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
  const decision = commitTransition(logPath, {
    manifest,
    from: options.from,
    target: options.target,
    workItemId: options.workItemId,
    force: options.forceMessage !== null ? { message: options.forceMessage } : null,
    manifestPath,
    now: deps.now,
  });

  return { manifest, forced: decision.forced, from: decision.from };
}

export type DriftKind = "manifest" | "phase-source" | "phase-missing" | "phase-extra" | "corrupt-lockfile";

export interface DriftDeps {
  loadManifest: typeof loadManifest;
  hashFileSync: typeof hashFileSync;
  readFileSync: (path: string) => string;
  existsSync: (path: string) => boolean;
  cwd: () => string;
}

export interface DriftEntry {
  kind: DriftKind;
  path: string;
  expected: string;
  actual: string;
}

export type DriftResult =
  | { status: "ok" }
  | { status: "no-lockfile" }
  | { status: "no-manifest" }
  | { status: "drift"; entries: DriftEntry[] };

/**
 * Detect drift between `.mcx.lock` and the on-disk manifest + phase sources.
 *
 * Must be called before phase dispatch. Any mismatch aborts execution — the
 * operator must review the diff and re-run `mcx phase install` explicitly.
 */
export function detectDrift(deps: DriftDeps): DriftResult {
  const cwd = deps.cwd();
  const lockPath = resolvePath(cwd, LOCKFILE_NAME);
  if (!deps.existsSync(lockPath)) return { status: "no-lockfile" };

  const loaded = deps.loadManifest(cwd);
  if (!loaded) return { status: "no-manifest" };

  let lock: Lockfile;
  try {
    lock = parseLockfile(deps.readFileSync(lockPath));
  } catch (err) {
    return {
      status: "drift",
      entries: [
        {
          kind: "corrupt-lockfile",
          path: LOCKFILE_NAME,
          expected: "valid lockfile",
          actual: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const entries: DriftEntry[] = [];

  const { path: manifestPath, manifest } = loaded;
  const manifestHash = deps.hashFileSync(manifestPath);
  if (manifestHash !== lock.manifestHash) {
    entries.push({
      kind: "manifest",
      path: relative(cwd, manifestPath).split("\\").join("/") || manifestPath,
      expected: lock.manifestHash,
      actual: manifestHash,
    });
  }

  const manifestPhases = new Set(Object.keys(manifest.phases));
  const lockedByName = new Map<string, LockedPhase>();
  for (const p of lock.phases) lockedByName.set(p.name, p);

  for (const locked of lock.phases) {
    if (!manifestPhases.has(locked.name)) {
      entries.push({
        kind: "phase-extra",
        path: locked.resolvedPath,
        expected: "(not in manifest)",
        actual: `phase "${locked.name}" in lockfile`,
      });
      continue;
    }
    const abs = resolvePath(cwd, locked.resolvedPath);
    let actualHash: string;
    try {
      actualHash = deps.hashFileSync(abs);
    } catch {
      entries.push({
        kind: "phase-source",
        path: locked.resolvedPath,
        expected: locked.contentHash,
        actual: "(file missing)",
      });
      continue;
    }
    if (actualHash !== locked.contentHash) {
      entries.push({
        kind: "phase-source",
        path: locked.resolvedPath,
        expected: locked.contentHash,
        actual: actualHash,
      });
    }
  }

  for (const name of manifestPhases) {
    if (!lockedByName.has(name)) {
      entries.push({
        kind: "phase-missing",
        path: manifest.phases[name].source,
        expected: `phase "${name}" in lockfile`,
        actual: "(not installed)",
      });
    }
  }

  if (entries.length === 0) return { status: "ok" };
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { status: "drift", entries };
}

/**
 * Render an actionable drift warning that names each changed file, shows both
 * hashes in "locked X → Y" form, and tells the reader how to recover.
 */
export function formatDriftWarning(entries: DriftEntry[]): string {
  const width = Math.max(20, ...entries.map((e) => e.path.length));
  const rows = entries
    .map((e) => {
      switch (e.kind) {
        case "manifest":
        case "phase-source": {
          const exp = shortHash(e.expected);
          const act = shortHash(e.actual);
          return `  ${e.path.padEnd(width)}  locked ${exp} → ${act}`;
        }
        case "phase-missing": {
          const detail = e.expected || "phase in manifest";
          return `  ${e.path.padEnd(width)}  [NOT INSTALLED] — ${detail} but missing from lockfile`;
        }
        case "phase-extra": {
          const detail = e.actual || "phase in lockfile";
          return `  ${e.path.padEnd(width)}  [STALE LOCK ENTRY] — ${detail} but removed from manifest`;
        }
        case "corrupt-lockfile": {
          const act = shortHash(e.actual);
          return `  ${e.path.padEnd(width)}  [CORRUPT LOCKFILE] — ${act}`;
        }
      }
    })
    .join("\n");
  return [
    `mcx phase: ${LOCKFILE_NAME} is out of date`,
    "",
    "Changes detected since last `mcx phase install`:",
    "",
    rows,
    "",
    `If this was intentional, run \`mcx phase install\` to regenerate ${LOCKFILE_NAME},`,
    `then stage and commit ${LOCKFILE_NAME} alongside the script change so future`,
    "orchestrators don't hit this error.",
  ].join("\n");
}

/**
 * Shared drift-abort used by `check` and `run`. Any non-ok status exits 1
 * with a message; callers resume normal flow only when drift status is ok.
 *
 * Wired into `run` so malicious phase-source mutations cannot execute: the
 * lockfile must match the on-disk manifest + sources before dispatch.
 */
function assertNoDrift(d: PhaseInstallDeps): void {
  const result = detectDrift(d);
  if (result.status === "ok") return;
  switch (result.status) {
    case "no-lockfile":
      d.logError(`no ${LOCKFILE_NAME} — run \`mcx phase install\` to create one`);
      break;
    case "no-manifest":
      d.logError("no .mcx.yaml or .mcx.json in this repo");
      break;
    case "drift":
      d.logError(formatDriftWarning(result.entries));
      break;
  }
  d.exit(1);
}

function shortHash(s: string): string {
  if (/^[a-f0-9]{40,}$/.test(s)) return s.slice(0, 6);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

export async function cmdPhase(
  args: string[],
  deps?: Partial<PhaseInstallDeps>,
  execDeps?: Partial<PhaseExecuteDeps>,
): Promise<void> {
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

    if (sub === "check") {
      assertNoDrift(d);
      d.log("lockfile ok");
      return;
    }

    if (sub === "list") {
      const json = args.includes("--json");
      const loaded = loadManifest(d.cwd());
      if (!loaded) {
        printError("no .mcx.yaml or .mcx.json in this repo");
        d.exit(1);
      }
      const lock = readLockfile(d.cwd());
      const rows = buildPhaseList(loaded.manifest, lock, d.cwd());
      if (json) {
        d.log(JSON.stringify(rows, null, 2));
      } else {
        for (const line of formatPhaseTable(rows)) d.log(line);
      }
      return;
    }

    if (sub === "show") {
      const rest = args.slice(1);
      const full = rest.includes("--full");
      const json = rest.includes("--json");
      const name = rest.find((a) => !a.startsWith("--"));
      if (!name) {
        printError("Usage: mcx phase show <name> [--full] [--json]");
        d.exit(1);
      }
      const loaded = loadManifest(d.cwd());
      if (!loaded) {
        printError("no .mcx.yaml or .mcx.json in this repo");
        d.exit(1);
      }
      const phase = loaded.manifest.phases[name];
      if (!phase) {
        const suggestions = suggestPhases(name, Object.keys(loaded.manifest.phases));
        const hint = suggestions.length > 0 ? ` did you mean: ${suggestions.join(", ")}?` : "";
        printError(`unknown phase "${name}".${hint}`);
        d.exit(1);
      }
      const lock = readLockfile(d.cwd());
      const info = buildPhaseShow(name, phase, loaded.manifest, lock, d.cwd(), full);
      if (json) {
        d.log(JSON.stringify(info, null, 2));
      } else {
        for (const line of formatPhaseShow(info)) d.log(line);
      }
      return;
    }

    if (sub === "why") {
      const rest = args.slice(1).filter((a) => !a.startsWith("--"));
      const json = args.includes("--json");
      if (rest.length !== 2) {
        printError("Usage: mcx phase why <from> <to>");
        d.exit(1);
      }
      const [from, to] = rest;
      const loaded = loadManifest(d.cwd());
      if (!loaded) {
        printError("no .mcx.yaml or .mcx.json in this repo");
        d.exit(1);
      }
      const result = explainTransition(loaded.manifest, from, to);
      if (json) {
        d.log(JSON.stringify(result, null, 2));
      } else {
        d.log(result.message);
      }
      if (!result.legal) d.exit(1);
      return;
    }

    if (sub === "log") {
      const opts = parsePhaseLogArgs(args.slice(1));
      const entries = filterTransitionLog(readAllTransitions(transitionLogPath(d.cwd())), opts);
      if (opts.json) {
        for (const e of entries) d.log(JSON.stringify(e));
      } else if (entries.length === 0) {
        d.log("no transitions recorded");
      } else {
        for (const line of formatTransitionLog(entries)) d.log(line);
      }
      return;
    }

    if (sub === "run") {
      const argv = args.slice(1);
      assertNoDrift(d);
      if (argv.includes("--dry-run")) {
        await runPhase(argv, d);
      } else if (argv.includes("--no-execute")) {
        const filtered = argv.filter((a) => a !== "--no-execute");
        const opts = parsePhaseRunArgs(filtered);
        const cwd = d.cwd();
        // Mirror the resolvedFrom fallback from executePhase (#1635):
        // Only do the expensive history-read + ipcCall when --from is absent.
        let resolvedFrom: string | null = opts.from;
        if (resolvedFrom === null) {
          const manifestForFrom = d.loadManifest(cwd);
          const priorTargets = manifestForFrom
            ? historyTargets(readTransitionHistory(transitionLogPath(cwd), opts.workItemId).filter(isCommitted))
            : [];
          if (priorTargets.length > 0) {
            resolvedFrom = priorTargets[priorTargets.length - 1];
          } else if (opts.workItemId !== null && manifestForFrom) {
            const ex: PhaseExecuteDeps = { ...defaultExecuteDeps, ...execDeps };
            try {
              const wi = (await ex.ipcCall("getWorkItem", { id: opts.workItemId })) as WorkItem | null;
              if (
                wi &&
                opts.target !== manifestForFrom.manifest.initial &&
                wi.phase in manifestForFrom.manifest.phases
              ) {
                resolvedFrom = wi.phase;
              }
            } catch {
              // ignore; resolvedFrom stays null
            }
          }
        }
        const result = phaseRun({ ...opts, from: resolvedFrom }, { cwd });
        const source = result.manifest.phases[opts.target]?.source ?? "(unknown)";
        const tag = result.forced ? " [FORCED]" : "";
        const trail = result.from ?? "(initial)";
        d.logError(`approved${tag}: ${trail} → ${opts.target} (${source})`);
      } else {
        await executePhase(argv, d);
      }
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

async function runPhase(argv: string[], d: PhaseInstallDeps): Promise<void> {
  const positional: string[] = [];
  const flags = new Set<string>();
  const extraArgs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arg") {
      const pair = argv[++i];
      if (!pair) {
        d.logError("--arg requires a key=val argument");
        d.exit(1);
      }
      const eq = pair.indexOf("=");
      if (eq === -1) {
        d.logError(`--arg value must be in key=val form, got: ${pair}`);
        d.exit(1);
      }
      const key = pair.slice(0, eq);
      if (!key) {
        d.logError(`--arg key must be non-empty in key=val form, got: ${pair}`);
        d.exit(1);
      }
      extraArgs[key] = pair.slice(eq + 1);
    } else if (a.startsWith("--")) {
      flags.add(a);
    } else {
      positional.push(a);
    }
  }
  const name = positional[0];
  if (!name) {
    d.logError("Usage: mcx phase run <name> --dry-run");
    d.exit(1);
  }
  if (!flags.has("--dry-run")) {
    d.logError("mcx phase run currently supports --dry-run only");
    d.exit(1);
  }

  const cwd = d.cwd();
  const loaded = d.loadManifest(cwd);
  if (!loaded) {
    d.logError("no .mcx.yaml or .mcx.json in this repo");
    d.exit(1);
  }

  const phase = loaded.manifest.phases[name];
  if (!phase) {
    d.logError(`unknown phase "${name}"`);
    d.exit(1);
  }

  let resolved: string;
  try {
    resolved = resolvePhaseSource(phase.source, cwd);
  } catch (err) {
    d.logError(`phase "${name}": ${err instanceof Error ? err.message : String(err)}`);
    d.exit(1);
  }

  let source: string;
  try {
    source = await d.readFile(resolved);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") d.logError(`phase "${name}": source ${phase.source} not found`);
    else d.logError(`phase "${name}": cannot read ${phase.source}: ${e?.message ?? String(err)}`);
    d.exit(1);
  }
  const structured = isDefineAlias(source);

  const { js } = await d.bundleAlias(resolved);

  const controller = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    controller.abort();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.kill(process.pid, sig);
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);

  const baseCtx: AliasContext = {
    mcp: {},
    args: extraArgs,
    file: (p) => Bun.file(p).text(),
    json: async (p) => JSON.parse(await Bun.file(p).text()),
    // Dry-run: use an in-memory no-op cache so producers still run but
    // nothing is written to ~/.mcp-cli/cache — avoids caching `undefined`
    // (the dry-run proxy return value) and corrupting real cache entries.
    cache: async (_k, producer) => producer() as Promise<never>,
    state: {} as AliasStateAccessor, // overwritten by wrapDryRunContext
    globalState: {} as AliasStateAccessor, // overwritten by wrapDryRunContext
    workItem: null,
    signal: controller.signal,
    waitForEvent: createWaitForEvent({ signal: controller.signal }),
  };
  const ctx = wrapDryRunContext(baseCtx, (line) => d.log(line));

  try {
    await d.executeAliasBundled(js, structured ? {} : undefined, ctx, structured);
  } catch (err) {
    d.logError(`phase "${name}" threw: ${err instanceof Error ? err.message : String(err)}`);
    d.exit(1);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

/**
 * Optional dependencies for real phase execution.
 *
 * Tests inject stubs for `ipcCall` and `exec` to avoid requiring a running
 * daemon or real git. Production code falls through to `defaultExecuteDeps`
 * which uses the real daemon IPC and `Bun.spawnSync`.
 */
export interface PhaseExecuteDeps {
  ipcCall: typeof ipcCall;
  exec: ExecFn;
  findGitRoot: (cwd: string) => string | null;
  now: () => Date;
}

export function spawnExec(cmd: string[]): ExecResult {
  const [bin, ...rest] = cmd;
  try {
    const r = Bun.spawnSync([bin, ...rest], { stdout: "pipe", stderr: "pipe" });
    // `exitCode` is null when the child was terminated by a signal (e.g. SIGKILL).
    // Surface that as a failure — `?? 0` previously masked signal-killed processes
    // as success and let the branch guard wave through a git that never ran.
    return { stdout: new TextDecoder().decode(r.stdout), exitCode: r.exitCode ?? 1 };
  } catch (error) {
    return { stdout: error instanceof Error ? error.message : String(error), exitCode: 1 };
  }
}

const defaultExecuteDeps: PhaseExecuteDeps = {
  ipcCall,
  exec: spawnExec,
  findGitRoot,
  now: () => new Date(),
};

export interface PhaseExecuteArgs {
  target: string;
  from: string | null;
  workItemId: string | null;
  forceMessage: string | null;
  args: Record<string, string>;
  inputJson: string | null;
}

/**
 * Parse `mcx phase run <target>` without `--dry-run` / `--no-execute`.
 * Supports transition flags (--from, --work-item, --force) plus execution
 * inputs: `--arg key=val` pairs and `--input <json>` for the handler input.
 */
export function parsePhaseExecuteArgs(argv: string[]): PhaseExecuteArgs {
  const passthrough: string[] = [];
  const cliArgs: Record<string, string> = {};
  let inputJson: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arg") {
      const pair = argv[++i];
      if (!pair) throw new Error("--arg requires a key=val argument");
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`--arg value must be in key=val form, got: ${pair}`);
      const key = pair.slice(0, eq);
      if (!key) throw new Error(`--arg key must be non-empty in key=val form, got: ${pair}`);
      cliArgs[key] = pair.slice(eq + 1);
    } else if (a.startsWith("--arg=")) {
      const pair = a.slice("--arg=".length);
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`--arg value must be in key=val form, got: ${pair}`);
      const key = pair.slice(0, eq);
      if (!key) throw new Error(`--arg key must be non-empty in key=val form, got: ${pair}`);
      cliArgs[key] = pair.slice(eq + 1);
    } else if (a === "--input") {
      inputJson = argv[++i] ?? null;
      if (inputJson === null) throw new Error("--input requires a JSON argument");
    } else if (a.startsWith("--input=")) {
      inputJson = a.slice("--input=".length);
    } else {
      passthrough.push(a);
    }
  }
  const opts = parsePhaseRunArgs(passthrough);
  return { ...opts, args: cliArgs, inputJson };
}

function toAliasWorkItem(w: WorkItem): AliasWorkItemInfo {
  return {
    id: w.id,
    issueNumber: w.issueNumber,
    prNumber: w.prNumber,
    branch: w.branch,
    phase: w.phase,
  };
}

/**
 * Execute a phase handler with a real context (issue #1381).
 *
 * Two-phase transition log (PR #1407 adversarial-review fix):
 *   1. Parse flags (transition + execution inputs)
 *   2. Fetch the work item from the daemon (if `--work-item` given).
 *      Done early so `work_items.phase` can seed `resolvedFrom` when
 *      the transition log is empty (#1522). Early-exit on missing id.
 *   3. Pre-validate the transition against committed history so bogus
 *      moves fail fast before we bundle or dispatch anything.
 *   4. Append an `"attempted"` entry to `.mcx/transitions.jsonl`. This
 *      captures attempt evidence from ANY branch, including cases that
 *      branch-guard rejects or handlers crash. Attempted entries are
 *      ignored by graph-walk / regression checks (#1407). Note: early
 *      exits before this point (unknown work-item id, unknown phase,
 *      disallowed transition) are not captured in the audit log.
 *   5. Branch guard: refuse to dispatch outside the manifest's `runsOn`
 *      branch. Attempt is already logged for audit.
 *   6. Bundle the phase source
 *   7. Build a live AliasContext: real MCP proxy + daemon-backed state
 *      (namespaced by the work-item id)
 *   8. Execute the handler
 *   9. On success (and only on success): `commitTransition` writes a
 *      `"committed"` entry. The transition commit runs AFTER the handler
 *      and branch guard, so failed or rejected runs leave only the
 *      `"attempted"` audit entry — retries are not blocked.
 *      `validateTransition` accepts an idempotent self-loop
 *      (`from === target && tail === target`) so handlers can be re-run
 *      without tripping `RegressionError` — handlers are expected to
 *      self-check state and return `"in-flight"` when already running.
 *
 * If the handler crashes, no committed entry is written: the work item
 * state is "tried but did not complete", and a retry will not be blocked
 * by the transition log.
 */
export async function executePhase(
  argv: string[],
  deps: Partial<PhaseInstallDeps>,
  execDeps?: Partial<PhaseExecuteDeps>,
): Promise<void> {
  const d: PhaseInstallDeps = { ...defaultDeps, ...deps };
  const ex: PhaseExecuteDeps = { ...defaultExecuteDeps, ...execDeps };
  const cwd = d.cwd();

  let parsed: PhaseExecuteArgs;
  try {
    parsed = parsePhaseExecuteArgs(argv);
  } catch (err) {
    d.logError(err instanceof Error ? err.message : String(err));
    d.exit(1);
  }

  const loaded = d.loadManifest(cwd);
  if (!loaded) {
    d.logError("no .mcx.yaml or .mcx.json in this repo");
    d.exit(1);
  }

  const phase = loaded.manifest.phases[parsed.target];
  if (!phase) {
    d.logError(
      `unknown phase "${parsed.target}".${(() => {
        const s = suggestPhases(parsed.target, Object.keys(loaded.manifest.phases));
        return s.length > 0 ? ` did you mean: ${s.join(", ")}?` : "";
      })()}`,
    );
    d.exit(1);
  }

  // Fetch work item early — needed for resolvedFrom fallback (#1522).
  // We do NOT auto-resolve the current branch to a work item — if the
  // orchestrator doesn't pass --work-item, phases self-enforce by throwing
  // from their own assertions (e.g. `if (!ctx.workItem) throw`).
  let workItem: AliasWorkItemInfo | null = null;
  if (parsed.workItemId !== null) {
    try {
      const wi = (await ex.ipcCall("getWorkItem", { id: parsed.workItemId })) as WorkItem | null;
      if (!wi) {
        d.logError(`work item "${parsed.workItemId}" not found`);
        d.exit(1);
      }
      workItem = toAliasWorkItem(wi);
    } catch (err) {
      d.logError(
        `failed to fetch work item "${parsed.workItemId}": ${err instanceof Error ? err.message : String(err)}`,
      );
      d.exit(1);
    }
  }

  // Pre-validate the transition with committed-only history so bogus
  // moves (unknown from, disallowed, un-forced regression) fail BEFORE
  // we spend cycles running the handler. The final commit below repeats
  // this under the transition lock; pre-check is a fail-fast guard, not
  // the source of truth.
  const logPath = transitionLogPath(cwd);
  const prior = readTransitionHistory(logPath, parsed.workItemId).filter(isCommitted);
  const priorTargets = historyTargets(prior);
  // When --from is not given and transition history is empty, fall back to
  // work_items.phase as the implicit "from" so manually-spawned impl sessions
  // don't cause a spurious "(initial) → triage" rejection (#1522).
  // Exceptions:
  //   - target === manifest.initial: first launch of the initial phase; keep
  //     from=null so Rule 4 (initial phase enforcement) still applies.
  //   - workItem.phase not in manifest.phases: stale/mismatched phase name
  //     (e.g. daemon stores "impl" but manifest declares "implement"); fall
  //     back to null to preserve the original Rule 4 error path (#1636).
  const resolvedFrom =
    parsed.from !== null
      ? parsed.from
      : priorTargets.length > 0
        ? priorTargets[priorTargets.length - 1]
        : parsed.target !== loaded.manifest.initial &&
            workItem?.phase != null &&
            workItem.phase in loaded.manifest.phases
          ? workItem.phase
          : null;
  validateTransition({
    manifest: loaded.manifest,
    from: resolvedFrom,
    target: parsed.target,
    history: priorTargets,
    workItemId: parsed.workItemId,
    force: parsed.forceMessage !== null ? { message: parsed.forceMessage } : null,
    manifestPath: loaded.path,
  });

  // Two-phase log — append an "attempted" entry before branch-guard or
  // handler dispatch. Captures audit evidence even when branch-guard
  // rejects or the handler crashes. Does NOT cover early exits above
  // (unknown work-item id, unknown/disallowed transition). Attempted
  // entries are ignored by regression / graph-walk checks (#1407).
  appendAttempt(logPath, {
    workItemId: parsed.workItemId,
    from: resolvedFrom,
    target: parsed.target,
    forceMessage: parsed.forceMessage,
    now: ex.now,
  });

  // Branch guard — phases execute with full shell/mcp access, so refuse
  // to dispatch from any branch other than the manifest's `runsOn`. The
  // attempt entry above captured the intent for audit.
  try {
    checkRunsOn({ cwd, manifest: loaded.manifest, exec: ex.exec });
  } catch (err) {
    if (err instanceof BranchGuardError) {
      d.logError(err.message);
      d.exit(1);
    }
    throw err;
  }

  let resolved: string;
  try {
    resolved = resolvePhaseSource(phase.source, cwd);
  } catch (err) {
    d.logError(`phase "${parsed.target}": ${err instanceof Error ? err.message : String(err)}`);
    d.exit(1);
  }

  let srcText: string;
  try {
    srcText = await d.readFile(resolved);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") d.logError(`phase "${parsed.target}": source ${phase.source} not found`);
    else d.logError(`phase "${parsed.target}": cannot read ${phase.source}: ${e?.message ?? String(err)}`);
    d.exit(1);
  }
  const structured = isDefineAlias(srcText);
  const { js } = await d.bundleAlias(resolved);

  const repoRoot = ex.findGitRoot(cwd) ?? NO_REPO_ROOT;
  // State is namespaced by work-item id so every phase touching the same
  // item sees the same scratchpad (see sprint state declarations in
  // .mcx.yaml). When no work item is bound we use an in-memory ephemeral
  // state that is discarded after the process exits, preventing cross-run
  // state leaks between unrelated invocations.
  const state = workItem
    ? createAliasState({ repoRoot, namespace: `workitem:${workItem.id}`, call: ex.ipcCall })
    : createEphemeralState();
  const phaseController = new AbortController();
  const onPhaseSignal = (sig: NodeJS.Signals) => {
    phaseController.abort();
    process.off("SIGINT", onPhaseInt);
    process.off("SIGTERM", onPhaseTerm);
    process.kill(process.pid, sig);
  };
  const onPhaseInt = () => onPhaseSignal("SIGINT");
  const onPhaseTerm = () => onPhaseSignal("SIGTERM");
  process.once("SIGINT", onPhaseInt);
  process.once("SIGTERM", onPhaseTerm);

  const ctx: AliasContext = {
    mcp: createMcpProxy({ call: ex.ipcCall, cwd }),
    args: parsed.args,
    file: (p) => Bun.file(p).text(),
    json: async (p) => JSON.parse(await Bun.file(p).text()),
    cache: createAliasCache(`phase:${parsed.target}`),
    state,
    globalState: createAliasState({ repoRoot, namespace: GLOBAL_STATE_NAMESPACE, call: ex.ipcCall }),
    workItem,
    signal: phaseController.signal,
    waitForEvent: createWaitForEvent({ signal: phaseController.signal }),
  };

  let input: unknown;
  if (parsed.inputJson !== null && parsed.inputJson !== "") {
    try {
      input = JSON.parse(parsed.inputJson);
    } catch {
      // Fall through to raw string; schema will reject if it needs an object.
      input = parsed.inputJson;
    }
  } else if (Object.keys(parsed.args).length > 0) {
    input = parsed.args;
  } else {
    input = {};
  }

  let output: unknown;
  try {
    output = await d.executeAliasBundled(js, structured ? input : undefined, ctx, structured);
  } catch (err) {
    // No committed entry — only the "attempted" record remains, so a
    // retry is not gated by this failure (#1407).
    d.logError(`phase "${parsed.target}" failed: ${err instanceof Error ? err.message : String(err)}`);
    d.exit(1);
  } finally {
    process.off("SIGINT", onPhaseInt);
    process.off("SIGTERM", onPhaseTerm);
  }

  // Handler succeeded — commit the transition. Idempotent self-loop
  // (`from === target && tail === target`) is accepted by
  // validateTransition so successive `phase run <X>` calls don't
  // trip RegressionError.
  const txResult = phaseRun(
    {
      target: parsed.target,
      from: resolvedFrom,
      workItemId: parsed.workItemId,
      forceMessage: parsed.forceMessage,
    },
    { cwd, now: ex.now },
  );
  const source = phase.source ?? "(unknown)";
  const tag = txResult.forced ? " [FORCED]" : "";
  const trail = txResult.from ?? "(initial)";
  d.logError(`approved${tag}: ${trail} → ${parsed.target} (${source})`);

  // Auto-persist work_items.phase so orchestrators don't need a separate
  // force_update after every phase run (#1745). Re-fetch the work item to
  // detect if the handler already updated phase (done/needs-attention).
  if (workItem && parsed.workItemId) {
    try {
      const fresh = (await ex.ipcCall("getWorkItem", { id: parsed.workItemId })) as WorkItem | null;
      if (fresh && fresh.phase !== parsed.target) {
        const repoRoot = ex.findGitRoot(cwd) ?? cwd;
        const updateResult = (await ex.ipcCall("callTool", {
          server: "_work_items",
          tool: "work_items_update",
          arguments: { id: parsed.workItemId, phase: parsed.target, repoRoot },
        })) as { isError?: boolean; content?: unknown } | null;
        if (updateResult?.isError) {
          d.logError(
            `non-fatal: failed to persist work item ${parsed.workItemId} phase to ${parsed.target}: ${JSON.stringify(updateResult.content ?? updateResult)}`,
          );
        }
      }
    } catch (error) {
      d.logError(
        `non-fatal: failed to persist work item ${parsed.workItemId} phase to ${parsed.target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (output !== undefined && output !== null) {
    if (typeof output === "string") {
      d.log(output);
    } else {
      d.log(JSON.stringify(output, null, 2));
    }
  }
}

function printPhaseHelp(d: PhaseInstallDeps): void {
  d.log(`mcx phase — orchestration phase graph

Subcommands:
  mcx phase install
      Resolve sources from .mcx.{yaml,json}, hash, write .mcx.lock.

  mcx phase check
      Verify .mcx.lock matches the manifest and phase sources. Exits non-zero on drift.

  mcx phase run <target> [--from <current>] [--work-item <id>] [--force <message>]
                          [--arg key=val ...] [--input <json>]
      Validate and record the transition, then execute the phase handler
      with a live ctx (daemon-backed state, real MCP proxy, work-item info).
      Structured return is printed to stdout as JSON so the orchestrator
      can pipe it: e.g. \`action: "spawn" | "wait" | "goto"\` for sprint
      phases. --force <message> bypasses disallowed-transition and
      regression checks; unknown-phase errors are never bypassable.

  mcx phase run <target> --no-execute [--from ...] [--work-item ...] [--force ...]
      Validate + log the transition without executing the handler. Use
      when the orchestrator wants to record intent separately from dispatch.

  mcx phase run <name> --dry-run [--arg key=val ...]
      Execute a phase handler with side effects logged but not dispatched.
      Use --arg to forward key=val pairs into ctx.args so dry-run exercises
      the same code paths as real execution.

  mcx phase list [--json]
      List all phases declared in the manifest with install status.

  mcx phase show <name> [--full] [--json]
      Show phase details: resolved source, content hash, declared state,
      legal transitions, source preview, last install time.

  mcx phase why <from> <to> [--json]
      Explain whether a transition is legal, via direct edge or shortest path.

  mcx phase log [--work-item <id>] [--forced-only] [--json]
      Print transitions from .mcx/transitions.jsonl, newest first.
      --forced-only shows only entries with a --force justification.
      --json emits one JSON object per line for piping.`);
}

export interface PhaseListRow {
  name: string;
  source: string;
  status: "ok" | "drift" | "missing" | "not-found";
  next: string[];
}

export function readLockfile(cwd: string): Lockfile | null {
  try {
    const text = readFileSync(resolvePath(cwd, LOCKFILE_NAME), "utf-8");
    return parseLockfile(text);
  } catch {
    return null;
  }
}

export function buildPhaseList(manifest: Manifest, lock: Lockfile | null, cwd: string): PhaseListRow[] {
  const lockMap = new Map<string, LockedPhase>();
  if (lock) for (const p of lock.phases) lockMap.set(p.name, p);
  const rows: PhaseListRow[] = [];
  for (const name of Object.keys(manifest.phases).sort()) {
    const phase = manifest.phases[name];
    const locked = lockMap.get(name);
    let status: PhaseListRow["status"];
    if (!lock) {
      status = "missing";
    } else if (!locked) {
      status = "missing";
    } else {
      try {
        const currentHash = hashFileSync(resolvePhaseSource(phase.source, cwd));
        status = currentHash === locked.contentHash ? "ok" : "drift";
      } catch {
        status = "not-found";
      }
    }
    rows.push({ name, source: phase.source, status, next: [...phase.next] });
  }
  return rows;
}

export function formatPhaseTable(rows: PhaseListRow[]): string[] {
  const headers = ["NAME", "SOURCE", "STATUS", "NEXT"];
  const cells = rows.map((r) => [r.name, r.source, r.status, r.next.length === 0 ? "—" : r.next.join(", ")]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const out: string[] = [];
  const pad = (row: string[]) =>
    row
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  out.push(pad(headers));
  for (const row of cells) out.push(pad(row));
  return out;
}

export interface PhaseShowInfo {
  name: string;
  source: string;
  resolvedPath: string | null;
  contentHash: string | null;
  lockedHash: string | null;
  schemaHash: string | null;
  state: ManifestState | undefined;
  next: string[];
  lastInstalled: string | null;
  preview: string[];
  previewTruncated: boolean;
}

export function buildPhaseShow(
  name: string,
  phase: Manifest["phases"][string],
  manifest: Manifest,
  lock: Lockfile | null,
  cwd: string,
  full: boolean,
): PhaseShowInfo {
  const locked = lock?.phases.find((p) => p.name === name) ?? null;
  let resolvedPath: string | null = null;
  let contentHash: string | null = null;
  let preview: string[] = [];
  let previewTruncated = false;
  try {
    const abs = resolvePhaseSource(phase.source, cwd);
    resolvedPath = relative(cwd, abs).split("\\").join("/") || ".";
    try {
      contentHash = hashFileSync(abs);
      const text = readFileSync(abs, "utf-8");
      const lines = text.split("\n");
      if (!full && lines.length > 20) {
        preview = lines.slice(0, 20);
        previewTruncated = true;
      } else {
        preview = lines;
      }
    } catch {
      // source unreadable
    }
  } catch {
    // unresolvable source (e.g. remote)
  }
  let lastInstalled: string | null = null;
  if (lock) {
    try {
      const st = statSync(resolvePath(cwd, LOCKFILE_NAME));
      lastInstalled = st.mtime.toISOString();
    } catch {
      // ignore
    }
  }
  return {
    name,
    source: phase.source,
    resolvedPath,
    contentHash,
    lockedHash: locked?.contentHash ?? null,
    schemaHash: locked?.schemaHash || null,
    state: manifest.state,
    next: [...phase.next],
    lastInstalled,
    preview,
    previewTruncated,
  };
}

export function formatPhaseShow(info: PhaseShowInfo): string[] {
  const out: string[] = [];
  out.push(`phase: ${info.name}`);
  out.push(`source: ${info.source}`);
  out.push(`resolved: ${info.resolvedPath ?? "(unresolved)"}`);
  if (info.contentHash) {
    const drift = info.lockedHash && info.lockedHash !== info.contentHash ? " (DRIFT vs lockfile)" : "";
    out.push(`contentHash: ${info.contentHash}${drift}`);
  } else {
    out.push("contentHash: (unreadable)");
  }
  if (info.lockedHash) out.push(`lockedHash: ${info.lockedHash}`);
  if (info.schemaHash) out.push(`schemaHash: ${info.schemaHash}`);
  out.push(`lastInstalled: ${info.lastInstalled ?? "(never)"}`);
  out.push("");
  out.push("state (manifest):");
  if (info.state && Object.keys(info.state).length > 0) {
    for (const k of Object.keys(info.state).sort()) out.push(`  ${k}: ${info.state[k]}`);
  } else {
    out.push("  (none)");
  }
  out.push("");
  out.push(`next: ${info.next.length === 0 ? "(terminal)" : info.next.join(", ")}`);
  out.push("");
  out.push(info.previewTruncated ? "source preview (first 20 lines, --full for all):" : "source:");
  for (const line of info.preview) out.push(`  ${line}`);
  return out;
}

export interface PhaseWhyResult {
  legal: boolean;
  kind: "direct" | "indirect" | "unknown-phase" | "disallowed" | "regression" | "cycle";
  from: string;
  to: string;
  path?: string[];
  message: string;
}

export function shortestPhasePath(manifest: Manifest, from: string, to: string): string[] | null {
  if (!(from in manifest.phases) || !(to in manifest.phases)) return null;
  if (from === to) return [from];
  const visited = new Set<string>([from]);
  const queue: { node: string; path: string[] }[] = [{ node: from, path: [from] }];
  while (queue.length > 0) {
    const { node, path } = queue.shift() as { node: string; path: string[] };
    for (const next of manifest.phases[node]?.next ?? []) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      visited.add(next);
      queue.push({ node: next, path: nextPath });
    }
  }
  return null;
}

export function explainTransition(manifest: Manifest, from: string, to: string): PhaseWhyResult {
  const declared = Object.keys(manifest.phases);
  const unknownFrom = !declared.includes(from);
  const unknownTo = !declared.includes(to);
  if (unknownFrom || unknownTo) {
    const parts: string[] = [];
    if (unknownFrom) {
      const s = suggestPhases(from, declared);
      parts.push(`unknown phase "${from}"${s.length > 0 ? ` (did you mean: ${s.join(", ")}?)` : ""}`);
    }
    if (unknownTo) {
      const s = suggestPhases(to, declared);
      parts.push(`unknown phase "${to}"${s.length > 0 ? ` (did you mean: ${s.join(", ")}?)` : ""}`);
    }
    return { legal: false, kind: "unknown-phase", from, to, message: parts.join("; ") };
  }

  if (from === to) {
    return {
      legal: false,
      kind: "disallowed",
      from,
      to,
      message: `"${from}" is already the current phase — no transition needed`,
    };
  }

  const direct = manifest.phases[from]?.next.includes(to) ?? false;
  if (direct) {
    return {
      legal: true,
      kind: "direct",
      from,
      to,
      path: [from, to],
      message: `${from} → ${to} is an approved direct transition`,
    };
  }

  const forward = shortestPhasePath(manifest, from, to);
  if (forward) {
    return {
      legal: true,
      kind: "indirect",
      from,
      to,
      path: forward,
      message: `${from} → ${to} is not direct. shortest legal path: ${forward.join(" → ")}`,
    };
  }

  const reverse = shortestPhasePath(manifest, to, from);
  if (reverse) {
    if (isPhaseInCycle(manifest, from)) {
      return {
        legal: false,
        kind: "cycle",
        from,
        to,
        path: reverse,
        message: `"${from}" is part of a cycle and has no forward path to "${to}" (${to} → ${from} reachable via: ${reverse.join(" → ")}). If this transition is intended, add "${to}" to phase "${from}"'s next: list.`,
      };
    }
    return {
      legal: false,
      kind: "regression",
      from,
      to,
      path: reverse,
      message: `${from} → ${to} would regress; can only transition forward (reverse path exists: ${reverse.join(" → ")})`,
    };
  }

  const allowed = manifest.phases[from]?.next ?? [];
  const approved = allowed.length > 0 ? allowed.join(", ") : "(none — terminal phase)";
  return {
    legal: false,
    kind: "disallowed",
    from,
    to,
    message: `${from} → ${to} is not an approved transition.\napproved from "${from}": ${approved}`,
  };
}
