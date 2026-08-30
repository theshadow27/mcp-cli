/**
 * `mcx claude auth save|load|ls` — scriptable Claude identity switching (#3006).
 * `ls --fetch` re-queries the usage API for the live identity and stamps the
 * result onto the active oauth profile so the table's 5H/7D/AS OF are current.
 * `ls --fetch-all` does the same, one profile at a time, for every stored
 * access token that is still valid. Expired tokens are skipped (they need a
 * load). 429s back off and abort the rest of the fleet. `ls` marks the
 * sticky recommended identity with `>`; `load --auto` switches to it.
 *
 * All three subcommands are non-interactive and agent-callable: JSON on `--json`
 * (stdout), human text otherwise, warnings and errors on stderr, meaningful exit
 * codes. The filesystem work lives in `../claude-auth-store` so it can be tested
 * against injected paths — no test ever touches a real `~/.claude`.
 */

import { fetchQuotaUsage } from "@mcp-cli/core";
import { type AuthPick, pickRecommended } from "../claude-auth-pick";
import {
  type AuthPaths,
  AuthProfileError,
  type ProfileSummary,
  type QuotaFetcher,
  type SleepFn,
  assertPlatformSupported,
  defaultAuthPaths,
  fetchUnexpiredProfileQuotas,
  listProfiles,
  loadProfile,
  readActivePointer,
  readLiveState,
  saveProfile,
  snapshotQuotaFromCredentials,
  snapshotQuotaFromCredentialsRetrying,
  stampActiveProfileQuota,
  stampProfileQuota,
  validateProfileName,
  withOperationLock,
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
  /** Injected by tests so save/load/`ls --fetch`/`ls --fetch-all` never hit the usage API. */
  fetchQuota: QuotaFetcher;
  /** Injected by tests so 429 backoff does not wait on the clock. */
  sleep: SleepFn;
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
    sleep: overrides?.sleep ?? ((ms: number) => Bun.sleep(ms)),
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
    fetch: { type: "boolean" },
    "fetch-all": { type: "boolean" },
    auto: { type: "boolean" },
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
        return await runLoad(parsed.positionals, { json, auto: parsed.flags.auto === true }, d, envDeps);
      case "ls":
        return await runLs(
          json,
          { fetch: parsed.flags.fetch === true, fetchAll: parsed.flags["fetch-all"] === true },
          d,
          envDeps,
        );
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

async function runLoad(
  positionals: string[],
  opts: { json: boolean; auto: boolean },
  d: AuthCliDeps,
  envDeps: AuthEnvDeps,
): Promise<void> {
  if (opts.auto && positionals[0]) {
    d.printError('Do not pass a profile name with --auto. Use "mcx claude auth load --auto" or "load <profile>".');
    return d.exit(EXIT_ERROR);
  }
  const now = envDeps.now();
  if (opts.auto) {
    const { profiles } = listProfiles(envDeps.paths, now);
    const pick = pickRecommended(profiles, now);
    if (pick.action !== "load" || !pick.profile) {
      if (opts.json) {
        d.log(JSON.stringify({ ok: true, action: pick.action, name: pick.profile, reason: pick.reason }, null, 2));
      } else {
        d.log(
          pick.action === "stay"
            ? `Already on recommended profile "${pick.profile}" (${pick.reason})`
            : `Not switching: ${pick.reason}`,
        );
      }
      return;
    }
    return loadNamed(pick.profile, { json: opts.json, pick }, d, envDeps, now);
  }
  const name = requireName(positionals, "mcx claude auth load <profile>", d);
  validateProfileName(name);
  return loadNamed(name, { json: opts.json }, d, envDeps, now);
}

async function loadNamed(
  name: string,
  opts: { json: boolean; pick?: AuthPick },
  d: AuthCliDeps,
  envDeps: AuthEnvDeps,
  now: Date,
): Promise<void> {
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

  if (opts.json) {
    d.log(
      JSON.stringify(
        {
          ok: true,
          action: "load",
          ...result,
          reason: opts.pick?.reason,
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

  if (opts.pick) d.log(`auto: ${opts.pick.reason}`);
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

async function fetchActive(d: AuthCliDeps, envDeps: AuthEnvDeps, now: Date): Promise<void> {
  const live = readLiveState(envDeps.paths, now);
  const snap = await snapshotQuotaFromCredentialsRetrying(live.credentials, now, envDeps.fetchQuota, {
    sleep: envDeps.sleep,
  });
  if (snap.warning) d.printInfo(`warning: ${snap.warning}`);
  else if (!snap.quota) d.printInfo("warning: could not snapshot quota: no access token in live credentials");
  const quota = snap.quota;
  if (quota) {
    // Skip the operation lock when there is no pointer so `--fetch` on an
    // empty store does not create `auth-profiles/` just to no-op.
    const stamped = readActivePointer(envDeps.paths)
      ? withOperationLock(envDeps.paths, () => stampActiveProfileQuota(envDeps.paths, quota))
      : false;
    if (!stamped) d.printInfo("warning: fetched quota but no active oauth profile to record it on");
  }
}

async function fetchAllUnexpired(d: AuthCliDeps, envDeps: AuthEnvDeps, now: Date): Promise<void> {
  const live = readLiveState(envDeps.paths, now);
  const { fetched, warnings, skippedExpired, skippedRateLimited } = await fetchUnexpiredProfileQuotas(
    envDeps.paths,
    now,
    envDeps.fetchQuota,
    { liveCredentials: live.credentials, sleep: envDeps.sleep },
  );
  for (const warning of warnings) d.printInfo(`warning: profile "${warning.name}": ${warning.message}`);
  if (skippedExpired.length > 0) {
    d.printInfo(`skipped ${skippedExpired.length} expired profile(s): ${skippedExpired.join(", ")}`);
  }
  if (skippedRateLimited.length > 0) {
    d.printInfo(`rate-limited; kept previous snapshots for: ${skippedRateLimited.join(", ")}`);
  }
  if (fetched.length === 0) return;
  withOperationLock(envDeps.paths, () => {
    for (const row of fetched) stampProfileQuota(envDeps.paths, row.name, row.quota);
  });
}

async function runLs(
  json: boolean,
  opts: { fetch: boolean; fetchAll: boolean },
  d: AuthCliDeps,
  envDeps: AuthEnvDeps,
): Promise<void> {
  const now = envDeps.now();
  if (opts.fetchAll) {
    await fetchAllUnexpired(d, envDeps, now);
  } else if (opts.fetch) {
    await fetchActive(d, envDeps, now);
  }

  const { profiles: summaries, problems } = listProfiles(envDeps.paths, now);
  const pick = pickRecommended(summaries, now);
  const listed = summaries.map((s) => ({
    ...s,
    recommended: pick.profile === s.name,
    recommendReason: pick.profile === s.name ? pick.reason : undefined,
  }));

  // A hand-edited profile must never hide the healthy ones — report it, keep going.
  for (const problem of problems) d.printInfo(`warning: profile "${problem.name}" is unreadable: ${problem.message}`);

  if (json) {
    d.log(JSON.stringify(listed, null, 2));
    return;
  }

  if (summaries.length === 0) {
    d.log('No auth profiles saved. Run "mcx claude auth save <profile>" to capture the current identity.');
    return;
  }

  for (const line of formatProfileTable(listed)) d.log(line);
  if (pick.profile && pick.action !== "stay") d.log(`> ${pick.profile}  ${pick.reason}`);
  else if (pick.action === "wait") d.log(`> (none)  ${pick.reason}`);
}

/** Render the `ls` table. Exported for tests — must never contain token material. */
export function formatProfileTable(summaries: Array<ProfileSummary & { recommended?: boolean }>): string[] {
  const rows = summaries.map((s) => ({
    marker: `${s.active ? "*" : " "}${s.recommended ? ">" : " "}`,
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
    `   ${"NAME".padEnd(nameW)}  ${"KIND".padEnd(kindW)}  ${"ACCOUNT".padEnd(accountW)}  ${"EXPIRES".padEnd(expiresW)}  ${"5H".padEnd(fiveW)}  ${"5H-RESET".padEnd(fiveResetW)}  ${"7D".padEnd(sevenW)}  ${"7D-RESET".padEnd(sevenResetW)}  ${"AS OF".padEnd(asOfW)}  REMOTE-CONTROL`,
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
