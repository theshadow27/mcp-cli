/**
 * `mcx claude profile ls|show|import` — manage spawn profiles (#935).
 *
 * A spawn profile is an env-var bundle in `~/.mcp-cli/profiles/<name>.env` that
 * `mcx claude spawn --profile <name>` hands to the spawned process. See
 * `@mcp-cli/core/spawn-profile` for the file format and precedence rules.
 *
 * Read paths here are deliberately value-blind: `show` prints key NAMES and never
 * values, so pasting its output into an issue or a transcript cannot leak a
 * credential. There is no `set KEY=VALUE` subcommand for the same reason — a
 * secret passed in argv lands in shell history and in every `ps` on the box.
 * Create a profile with an editor, or `import` an existing env/shell file.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  SpawnProfileError,
  describeSpawnProfile,
  listSpawnProfiles,
  loadSpawnProfile,
  options,
  parseSpawnProfileEnv,
  spawnProfilePath,
} from "@mcp-cli/core";
import { extractJsonFlag } from "../parse";

/**
 * Output seams. Structurally a subset of `ClaudeDeps`, declared locally so this
 * module stays a leaf of the import graph (`claude.ts` ↔ `agent.ts` is a cycle).
 */
export interface ProfileCliDeps {
  log: (...args: unknown[]) => void;
  printError: (msg: string) => void;
  printInfo: (msg: string) => void;
  exit: (code: number) => never;
}

const PROFILE_SUBCOMMANDS = ["ls", "show", "import"] as const;

/** Mode for the profiles directory and every file in it — a secret store. */
const PROFILE_DIR_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;

export async function claudeProfile(args: string[], d: ProfileCliDeps): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const sub = rest[0] ?? "ls";
  try {
    switch (sub) {
      case "ls":
      case "list":
        profileList(json, d);
        return;
      case "show":
        profileShow(rest[1], json, d);
        return;
      case "import":
        profileImport(rest[1], rest[2], d);
        return;
      default:
        d.printError(`Unknown profile subcommand: ${sub}. Use ${PROFILE_SUBCOMMANDS.join(", ")}.`);
        d.exit(1);
    }
  } catch (err) {
    // SpawnProfileError messages are value-free by construction (see spawn-profile.ts).
    d.printError(err instanceof SpawnProfileError ? err.message : String(err));
    d.exit(1);
  }
}

function profileList(json: boolean, d: ProfileCliDeps): void {
  const names = listSpawnProfiles();
  if (json) {
    d.log(JSON.stringify({ dir: options.PROFILES_DIR, profiles: names }, null, 2));
    return;
  }
  if (names.length === 0) {
    d.printInfo(`No spawn profiles in ${options.PROFILES_DIR}`);
    d.printInfo("Create one with: mcx claude profile import <name> <file>");
    return;
  }
  for (const name of names) d.log(name);
}

function profileShow(name: string | undefined, json: boolean, d: ProfileCliDeps): void {
  if (!name) {
    d.printError("Usage: mcx claude profile show <name> [--json]");
    d.exit(1);
    return;
  }
  // describeSpawnProfile drops every value — this command cannot print a secret.
  const summary = describeSpawnProfile(loadSpawnProfile(name));
  if (json) {
    d.log(JSON.stringify(summary, null, 2));
  } else {
    d.log(`${summary.name}  ${summary.path}`);
    for (const key of summary.keys) {
      d.log(summary.unsets.includes(key) ? `  ${key}  (unset)` : `  ${key}`);
    }
  }
  if (summary.insecureMode) {
    d.printError(`warning: ${summary.path} is group/world-readable — run: chmod 600 ${summary.path}`);
  }
}

function profileImport(name: string | undefined, source: string | undefined, d: ProfileCliDeps): void {
  if (!name || !source) {
    d.printError("Usage: mcx claude profile import <name> <file>");
    d.exit(1);
    return;
  }
  const dest = spawnProfilePath(name);
  const src = isAbsolute(source) ? source : resolve(process.cwd(), source);
  if (existsSync(dest)) {
    d.printError(`profile "${name}" already exists (${dest}) — remove it first`);
    d.exit(1);
    return;
  }
  const st = statSync(src);
  if (!st.isFile()) {
    d.printError(`${src} is not a regular file`);
    d.exit(1);
    return;
  }
  // Parse before writing: an import that lands a malformed file would fail later,
  // at spawn time, when the operator is already stuck.
  const text = readFileSync(src, "utf-8");
  const env = parseSpawnProfileEnv(text, src);

  mkdirSync(options.PROFILES_DIR, { recursive: true, mode: PROFILE_DIR_MODE });
  chmodSync(options.PROFILES_DIR, PROFILE_DIR_MODE);
  // Write via copy then chmod rather than preserving the source's mode — the
  // source may well be a 0644 shell script the operator has been sourcing.
  copyFileSync(src, dest);
  chmodSync(dest, PROFILE_FILE_MODE);
  d.printInfo(`imported profile "${name}" → ${dest} (${Object.keys(env).length} vars, mode 600)`);
}
