/**
 * `mcx claude auth save|load|ls` — scriptable Claude identity switching (#3006).
 *
 * All three subcommands are non-interactive and agent-callable: JSON on `--json`
 * (stdout), human text otherwise, warnings and errors on stderr, meaningful exit
 * codes. The filesystem work lives in `../claude-auth-store` so it can be tested
 * against injected paths — no test ever touches a real `~/.claude`.
 */

import { fetchQuotaUsage } from "@mcp-cli/core";
import {
  type AuthPaths,
  AuthProfileError,
  type ProfileSummary,
  type QuotaFetcher,
  assertPlatformSupported,
  defaultAuthPaths,
  listProfiles,
  loadProfile,
  readLiveState,
  saveProfile,
  snapshotQuotaFromCredentials,
  validateProfileName,
} from "../claude-auth-store";
import { parseFlags } from "../flags";

/**
 * Output seams. Structurally a subset of `ClaudeDeps`, declared locally so this
 * module stays a leaf of the import graph (`claude.ts` ↔ `agent.ts` is already a cycle).
 */
export interface AuthCliDeps {
  log: (...args: unknown[]) => void;
  printError: (msg: string) => void;
  printInfo: (msg: string) => void;
  exit: (code: number) => never;
}

/** Exit code for "this platform can't do credential swapping yet". */
export const EXIT_UNSUPPORTED_PLATFORM = 2;
/** Exit code for every other expected failure (bad name, missing profile, locked config). */
export const EXIT_ERROR = 1;

/** Environment/filesystem seams, injected by tests. */
export interface AuthEnvDeps {
  paths: AuthPaths;
  env: Record<string, string | undefined>;
  platform: string;
  now: () => Date;
  /** Injected by tests so save/load never hit the usage API. */
  fetchQuota: QuotaFetcher;
}

function resolveEnvDeps(overrides?: Partial<AuthEnvDeps>): AuthEnvDeps {
  const env = overrides?.env ?? process.env;
  return {
    // Path resolution reads CLAUDE_CONFIG_DIR out of the same env object.
    paths: overrides?.paths ?? defaultAuthPaths(env),
    env,
    platform: overrides?.platform ?? process.platform,
    now: overrides?.now ?? (() => new Date()),
    fetchQuota: overrides?.fetchQuota ?? fetchQuotaUsage,
  };
}

/** Subcommands that read or write Claude's own credential files. */
const MUTATING_SUBCOMMANDS: ReadonlySet<string> = new Set(["save", "load"]);

const AUTH_SUBCOMMANDS = ["save", "load", "ls"] as const;
type AuthSubcommand = (typeof AUTH_SUBCOMMANDS)[number];

function isAuthSubcommand(value: string): value is AuthSubcommand {
  return (AUTH_SUBCOMMANDS as readonly string[]).includes(value);
}

export async function claudeAuth(args: string[], d: AuthCliDeps, overrides?: Partial<AuthEnvDeps>): Promise<void> {
  const sub = args[0] ?? "";

  // Platform gate first: on an unsupported platform we must not even stat Claude's
  // files, so the "nothing was read or written" promise is literally true.
  if (MUTATING_SUBCOMMANDS.has(sub)) {
    try {
      assertPlatformSupported(overrides?.platform ?? process.platform);
    } catch (err) {
      if (err instanceof AuthProfileError) {
        d.printError(err.message);
        return d.exit(EXIT_UNSUPPORTED_PLATFORM);
      }
      throw err;
    }
  }

  const envDeps = resolveEnvDeps(overrides);

  if (!isAuthSubcommand(sub)) {
    d.printError(
      `Unknown claude auth subcommand: "${sub || "(none)"}". Use "save <profile>", "load <profile>", or "ls".`,
    );
    return d.exit(EXIT_ERROR);
  }

  const parsed = parseFlags(args.slice(1), {
    json: { type: "boolean" },
    oauth: { type: "boolean" },
    "api-key-env": { type: "string" },
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) d.printError(err);
    return d.exit(EXIT_ERROR);
  }
  const json = parsed.flags.json === true;
  const apiKeyEnvFlag = typeof parsed.flags["api-key-env"] === "string" ? parsed.flags["api-key-env"] : undefined;

  try {
    switch (sub) {
      case "save":
        return await runSave(
          parsed.positionals,
          { json, apiKeyEnvVar: apiKeyEnvFlag, forceOauth: parsed.flags.oauth === true },
          d,
          envDeps,
        );
      case "load":
        return await runLoad(parsed.positionals, json, d, envDeps);
      case "ls":
        return await runLs(json, d, envDeps);
    }
  } catch (err) {
    if (err instanceof AuthProfileError) {
      d.printError(err.message);
      return d.exit(err.code === "unsupported-platform" ? EXIT_UNSUPPORTED_PLATFORM : EXIT_ERROR);
    }
    throw err;
  }
}

function requireName(positionals: string[], usage: string, d: AuthCliDeps): string {
  const name = positionals[0];
  if (!name) {
    d.printError(`Missing profile name. Usage: ${usage}`);
    return d.exit(EXIT_ERROR);
  }
  return name;
}

async function runSave(
  positionals: string[],
  opts: { json: boolean; apiKeyEnvVar: string | undefined; forceOauth: boolean },
  d: AuthCliDeps,
  envDeps: AuthEnvDeps,
): Promise<void> {
  const name = requireName(positionals, "mcx claude auth save <profile>", d);
  validateProfileName(name);
  const now = envDeps.now();
  const apiKeyEnvVar = opts.forceOauth
    ? undefined
    : (opts.apiKeyEnvVar ?? (envDeps.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : undefined));

  let quotaWarning: string | undefined;
  let quota: Awaited<ReturnType<typeof snapshotQuotaFromCredentials>>["quota"];
  if (!apiKeyEnvVar) {
    const live = readLiveState(envDeps.paths, now);
    const snap = await snapshotQuotaFromCredentials(live.credentials, now, envDeps.fetchQuota);
    quota = snap.quota;
    quotaWarning = snap.warning;
  }

  const result = saveProfile({
    paths: envDeps.paths,
    name,
    env: envDeps.env,
    now,
    platform: envDeps.platform,
    apiKeyEnvVar: opts.apiKeyEnvVar,
    forceOauth: opts.forceOauth,
    quota,
  });

  if (quotaWarning) d.printInfo(`warning: ${quotaWarning}`);
  for (const warning of result.warnings) d.printInfo(`warning: ${warning}`);

  if (opts.json) {
    d.log(
      JSON.stringify(
        {
          ok: true,
          action: "save",
          name,
          kind: result.profile.kind,
          replaced: result.replaced,
          active: result.becameActive,
          apiKeyEnvVar: result.profile.apiKeyEnvVar ?? null,
          credentialsPath: envDeps.paths.credentialsPath,
          claudeConfigPath: envDeps.paths.claudeConfigPath,
          warnings: quotaWarning ? [quotaWarning, ...result.warnings] : result.warnings,
        },
        null,
        2,
      ),
    );
    return;
  }

  const verb = result.replaced ? "Updated" : "Saved";
  d.log(`${verb} auth profile "${name}" (${result.profile.kind})`);
  if (result.profile.apiKeyEnvVar) d.log(`  expects env var: ${result.profile.apiKeyEnvVar} (value not stored)`);
  if (result.becameActive) d.log(`  active profile is now "${name}"`);
}

async function runLoad(positionals: string[], json: boolean, d: AuthCliDeps, envDeps: AuthEnvDeps): Promise<void> {
  const name = requireName(positionals, "mcx claude auth load <profile>", d);
  validateProfileName(name);
  const now = envDeps.now();
  // Fetch before any lock so a slow usage call does not hold ~/.claude.json.
  const live = readLiveState(envDeps.paths, now);
  const snap = await snapshotQuotaFromCredentials(live.credentials, now, envDeps.fetchQuota);
  if (snap.warning) d.printInfo(`warning: ${snap.warning}`);

  const result = loadProfile({
    paths: envDeps.paths,
    name,
    env: envDeps.env,
    now,
    platform: envDeps.platform,
    outgoingQuota: snap.quota,
  });

  for (const warning of result.warnings) d.printInfo(`warning: ${warning}`);

  if (json) {
    d.log(
      JSON.stringify(
        {
          ok: true,
          action: "load",
          ...result,
          warnings: snap.warning ? [snap.warning, ...result.warnings] : result.warnings,
          credentialsPath: envDeps.paths.credentialsPath,
          claudeConfigPath: envDeps.paths.claudeConfigPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  d.log(`Loaded auth profile "${name}" (${result.kind})`);
  if (result.wroteBack) {
    d.log(
      result.wroteBackChanged
        ? `  wrote refreshed credentials back to "${result.wroteBack}"`
        : `  "${result.wroteBack}" was already up to date`,
    );
  }
  if (result.outgoingPreservedAs === "already-stored") d.log("  outgoing credentials were already stored in a profile");
  if (result.backupDir) d.log(`  backed up pre-existing credentials to ${result.backupDir}`);
  if (result.orphanBackupDir) d.log(`  backed up unattributed credentials to ${result.orphanBackupDir}`);
  if (result.credentialsWritten) d.log("  credentials written");
  if (result.identityWritten) d.log("  identity keys updated in ~/.claude.json");
  if (result.policyInvalidated) d.log("  org policy cache invalidated (policy-limits.json removed)");
}

async function runLs(json: boolean, d: AuthCliDeps, envDeps: AuthEnvDeps): Promise<void> {
  const { profiles: summaries, problems } = listProfiles(envDeps.paths, envDeps.now());

  // A hand-edited profile must never hide the healthy ones — report it, keep going.
  for (const problem of problems) d.printInfo(`warning: profile "${problem.name}" is unreadable: ${problem.message}`);

  if (json) {
    d.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (summaries.length === 0) {
    d.log('No auth profiles saved. Run "mcx claude auth save <profile>" to capture the current identity.');
    return;
  }

  for (const line of formatProfileTable(summaries)) d.log(line);
}

/** Render the `ls` table. Exported for tests — must never contain token material. */
export function formatProfileTable(summaries: ProfileSummary[]): string[] {
  const rows = summaries.map((s) => ({
    marker: s.active ? "*" : " ",
    name: s.name,
    kind: s.kind,
    account: s.kind === "api-key" ? `$${s.apiKeyEnvVar ?? "ANTHROPIC_API_KEY"}` : (s.account ?? "-"),
    expires: formatExpiry(s),
    fiveHour: formatPct(s.quota?.fiveHour?.utilization),
    fiveReset: formatStamp(s.quota?.fiveHour?.resetsAt),
    sevenDay: formatPct(s.quota?.sevenDay?.utilization),
    sevenReset: formatStamp(s.quota?.sevenDay?.resetsAt),
    asOf: formatStamp(s.quota?.capturedAt),
    remote: s.allowRemoteControl === null ? "unknown" : s.allowRemoteControl ? "yes" : "no",
  }));

  const width = (pick: (r: (typeof rows)[number]) => string, header: string) =>
    Math.max(header.length, ...rows.map((r) => pick(r).length));
  const nameW = width((r) => r.name, "NAME");
  const kindW = width((r) => r.kind, "KIND");
  const accountW = width((r) => r.account, "ACCOUNT");
  const expiresW = width((r) => r.expires, "EXPIRES");
  const fiveW = width((r) => r.fiveHour, "5H");
  const fiveResetW = width((r) => r.fiveReset, "5H-RESET");
  const sevenW = width((r) => r.sevenDay, "7D");
  const sevenResetW = width((r) => r.sevenReset, "7D-RESET");
  const asOfW = width((r) => r.asOf, "AS OF");

  const lines = [
    `  ${"NAME".padEnd(nameW)}  ${"KIND".padEnd(kindW)}  ${"ACCOUNT".padEnd(accountW)}  ${"EXPIRES".padEnd(expiresW)}  ${"5H".padEnd(fiveW)}  ${"5H-RESET".padEnd(fiveResetW)}  ${"7D".padEnd(sevenW)}  ${"7D-RESET".padEnd(sevenResetW)}  ${"AS OF".padEnd(asOfW)}  REMOTE-CONTROL`,
  ];
  for (const r of rows) {
    lines.push(
      `${r.marker} ${r.name.padEnd(nameW)}  ${r.kind.padEnd(kindW)}  ${r.account.padEnd(accountW)}  ${r.expires.padEnd(expiresW)}  ${r.fiveHour.padEnd(fiveW)}  ${r.fiveReset.padEnd(fiveResetW)}  ${r.sevenDay.padEnd(sevenW)}  ${r.sevenReset.padEnd(sevenResetW)}  ${r.asOf.padEnd(asOfW)}  ${r.remote}`,
    );
  }
  return lines;
}

function formatExpiry(summary: ProfileSummary): string {
  if (summary.expiresAt === null) return "-";
  const stamp = formatStamp(summary.expiresAt);
  return summary.expired ? `${stamp} (expired)` : stamp;
}

function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  return iso.replace("T", " ").slice(0, 16);
}

function formatPct(n: number | null | undefined): string {
  if (n == null) return "-";
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
}
