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
  executeAliasBundled,
  extractMetadata,
  hashFileSync,
  historyTargets,
  isDefineAlias,
  loadManifest,
  parseLockfile,
  readTransitionHistory,
  serializeLockfile,
  sha256Hex,
  suggestPhases,
  validateTransition,
  wrapDryRunContext,
} from "@mcp-cli/core";
import type { AliasMetadata } from "@mcp-cli/core";
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
 * Render the stern drift warning. No "just run install" prompt — the user
 * must review the diff first, then regenerate the lockfile explicitly.
 */
export function formatDriftWarning(entries: DriftEntry[]): string {
  const header =
    "PHASE LOCKFILE DRIFT DETECTED\n\nThe manifest or a phase source has changed since the last install:\n";
  const width = Math.max(20, ...entries.map((e) => e.path.length));
  const rows = entries
    .map((e) => {
      const label = labelFor(e.kind);
      const exp = shortHash(e.expected);
      const act = shortHash(e.actual);
      return `  ${e.path.padEnd(width)}  [${label}]  expected ${exp}, got ${act}`;
    })
    .join("\n");
  const footer = `

Phases will not execute until the lockfile is regenerated.

Before regenerating:
  - Review the diff. A malicious PR can inject phase source that runs at
    orchestrator time with full shell/mcp access.
  - Confirm the changes are intentional and reviewed.
  - Understand that re-running install makes them executable.

To regenerate after review:  mcx phase install`;
  return `${header}\n${rows}${footer}`;
}

function labelFor(kind: DriftKind): string {
  switch (kind) {
    case "manifest":
    case "phase-source":
      return "HASH MISMATCH";
    case "phase-missing":
      return "NOT INSTALLED";
    case "phase-extra":
      return "STALE LOCK ENTRY";
    case "corrupt-lockfile":
      return "CORRUPT LOCKFILE";
  }
}

function shortHash(s: string): string {
  if (/^[a-f0-9]{40,}$/.test(s)) return s.slice(0, 6);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
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

    if (sub === "check") {
      const result = detectDrift(d);
      switch (result.status) {
        case "no-lockfile":
          d.logError(`no ${LOCKFILE_NAME} — run \`mcx phase install\` to create one`);
          d.exit(1);
          break;
        case "no-manifest":
          d.logError("no .mcx.yaml or .mcx.json in this repo");
          d.exit(1);
          break;
        case "drift":
          d.logError(formatDriftWarning(result.entries));
          d.exit(1);
          break;
        case "ok":
          d.log("lockfile ok");
          break;
      }
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

    if (sub === "run") {
      const argv = args.slice(1);
      if (argv.includes("--dry-run")) {
        await runPhase(argv, d);
      } else {
        const opts = parsePhaseRunArgs(argv);
        const result = phaseRun(opts, { cwd: d.cwd() });
        const source = result.manifest.phases[opts.target]?.source ?? "(unknown)";
        const tag = result.forced ? " [FORCED]" : "";
        const trail = result.from ?? "(initial)";
        d.logError(`approved${tag}: ${trail} → ${opts.target} (${source})`);
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
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else positional.push(a);
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

  const stubState = {
    get: async () => undefined,
    all: async () => ({}),
    set: async () => {},
    delete: async () => {},
  };
  const baseCtx: AliasContext = {
    mcp: {},
    args: {},
    file: (p) => Bun.file(p).text(),
    json: async (p) => JSON.parse(await Bun.file(p).text()),
    // Dry-run: use an in-memory no-op cache so producers still run but
    // nothing is written to ~/.mcp-cli/cache — avoids caching `undefined`
    // (the dry-run proxy return value) and corrupting real cache entries.
    cache: async (_k, producer) => producer() as Promise<never>,
    state: stubState,
    globalState: stubState,
    workItem: null,
  };
  const ctx = wrapDryRunContext(baseCtx, (line) => d.log(line));

  await d.executeAliasBundled(js, structured ? {} : undefined, ctx, structured);
}

function printPhaseHelp(d: PhaseInstallDeps): void {
  d.log(`mcx phase — orchestration phase graph

Subcommands:
  mcx phase install
      Resolve sources from .mcx.{yaml,json}, hash, write .mcx.lock.

  mcx phase check
      Verify .mcx.lock matches the manifest and phase sources. Exits non-zero on drift.

  mcx phase run <target> [--from <current>] [--work-item <id>] [--force <message>]
      Validate and record a phase transition against .mcx.{yaml,json}.
      --force <message> bypasses disallowed-transition and regression checks;
      unknown-phase errors are never bypassable.

  mcx phase run <name> --dry-run
      Execute a phase handler with side effects logged but not dispatched.

  mcx phase list [--json]
      List all phases declared in the manifest with install status.

  mcx phase show <name> [--full] [--json]
      Show phase details: resolved source, content hash, declared state,
      legal transitions, source preview, last install time.

  mcx phase why <from> <to> [--json]
      Explain whether a transition is legal, via direct edge or shortest path.`);
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
  kind: "direct" | "indirect" | "unknown-phase" | "disallowed" | "regression";
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
