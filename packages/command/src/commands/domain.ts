/**
 * `mcx domain` — the domains table: a name bound to `[host:]path`, and nothing else.
 *
 *   mcx domain add <name> [host:]<path>   register
 *   mcx domain ls [--json]                list
 *   mcx domain show <name> [--json]       resolve to host + path
 *   mcx domain which [path] [--json]      reverse lookup — which domain owns this path?
 *   mcx domain rename <old> <new>         name change only; never touches path
 *   mcx domain rm <name> [--force]        refuses while dependents exist
 *   mcx domain import [--force]           re-run the one-shot legacy import (#3034)
 *
 * See `docs/domains.md`. This file holds no resolution logic: `which` asks the daemon,
 * which asks `resolveDomainForPath`, so there is exactly one walk-up rule in the codebase.
 */

import { homedir } from "node:os";
import type { Domain, IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { expandLocalDomainPath, formatDomainLocation, ipcCall, resolveDomainLocation } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { c, printError } from "../output";

export interface DomainDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  exit: (code: number) => never;
  cwd: () => string;
  home: () => string;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultDeps: DomainDeps = {
  ipcCall,
  exit: (code) => process.exit(code),
  cwd: () => process.cwd(),
  home: () => homedir(),
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** Render a domain row as the `[host:]path` form `mcx domain add` accepts. */
function location(domain: Domain): string {
  return formatDomainLocation({ host: domain.host, path: domain.path });
}

export async function cmdDomain(args: string[], deps: DomainDeps = defaultDeps): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printDomainHelp(deps);
    return;
  }

  switch (sub) {
    case "add":
      return domainAdd(args.slice(1), deps);
    case "ls":
    case "list":
      return domainLs(args.slice(1), deps);
    case "show":
      return domainShow(args.slice(1), deps);
    case "which":
      return domainWhich(args.slice(1), deps);
    case "rename":
      return domainRename(args.slice(1), deps);
    case "rm":
    case "remove":
      return domainRm(args.slice(1), deps);
    case "import":
      return domainImport(args.slice(1), deps);
    default:
      printError(`Unknown subcommand: mcx domain ${sub}`);
      printDomainHelp(deps);
      deps.exit(1);
  }
}

/**
 * Gate every subcommand on its parsed flags: exit on a parse error, and **stop before any
 * side effect when `--help` was asked for**.
 *
 * `parseFlags` swallows `--help`/`-h` into `result.help` and leaves the positionals intact,
 * so a subcommand that ignores that field runs normally with the flag simply gone —
 * `mcx domain rm phoenix --force --help` parses to `{help: true, positionals: ["phoenix"],
 * flags: {force: true}}` and would cascade-delete a domain and every row bound to it. An
 * operator appending `--help` before running something destructive is doing the exact thing
 * that is supposed to save them.
 *
 * No command under `packages/command/src/commands/` reads `result.help` today; the repo-wide
 * fix is #1518. This is the local guard, because this is the first command surface with a
 * cascading delete behind it.
 *
 * Callers must `return` on `"help"` — the returned union is what makes ignoring it a type
 * error at the call site rather than a silent fall-through.
 */
type FlagGate = "ok" | "help";

function gateFlags(result: ReturnType<typeof parseFlags>, usage: string, deps: DomainDeps): FlagGate {
  if (result.errors.length > 0) {
    for (const err of result.errors) printError(err);
    printError(usage);
    deps.exit(1);
  }
  if (result.help) {
    printDomainHelp(deps);
    return "help";
  }
  return "ok";
}

async function domainAdd(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain add <name> [host:]<path>";
  const parsed = parseFlags(args, {});
  if (gateFlags(parsed, usage, deps) === "help") return;

  const [name, spec] = parsed.positionals;
  if (!name || !spec) {
    printError(usage);
    deps.exit(1);
  }

  // `~` and a relative path are expanded here, against the caller's home and cwd —
  // the daemon's are not the user's, and a relative path in the table is a latent bug.
  let host: string | null;
  let path: string;
  try {
    ({ host, path } = resolveDomainLocation(spec, { home: deps.home(), cwd: deps.cwd() }));
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return deps.exit(1);
  }

  const domain = await deps.ipcCall("domainAdd", { name, host, path });
  deps.error(`Domain "${domain.name}" registered at ${location(domain)}`);
}

async function domainLs(args: string[], deps: DomainDeps): Promise<void> {
  const parsed = parseFlags(args, { json: { type: "boolean" } });
  if (gateFlags(parsed, "Usage: mcx domain ls [--json]", deps) === "help") return;

  const domains = await deps.ipcCall("domainList");
  if (parsed.flags.json) {
    deps.log(JSON.stringify(domains, null, 2));
    return;
  }
  if (domains.length === 0) {
    deps.error("No domains registered. Use `mcx domain add <name> [host:]<path>` to create one.");
    return;
  }
  const width = Math.max(...domains.map((d) => d.name.length));
  for (const domain of domains) {
    deps.log(`  ${c.bold}${domain.name.padEnd(width)}${c.reset}  ${location(domain)}`);
  }
}

async function domainShow(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain show <name> [--json]";
  const parsed = parseFlags(args, { json: { type: "boolean" } });
  if (gateFlags(parsed, usage, deps) === "help") return;

  const name = parsed.positionals[0];
  if (!name) {
    printError(usage);
    deps.exit(1);
  }

  const domain = await deps.ipcCall("domainShow", { name });
  if (!domain) {
    printError(`No domain named "${name}"`);
    return deps.exit(1);
  }
  if (parsed.flags.json) {
    deps.log(JSON.stringify(domain, null, 2));
    return;
  }
  deps.log(`${c.bold}${domain.name}${c.reset}`);
  deps.log(`  location  ${location(domain)}`);
  deps.log(`  host      ${domain.host ?? `${c.dim}(local)${c.reset}`}`);
  deps.log(`  path      ${domain.path}`);
  deps.log(`  created   ${domain.createdAt}`);
}

async function domainWhich(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain which [path] [--json]";
  const parsed = parseFlags(args, { json: { type: "boolean" } });
  if (gateFlags(parsed, usage, deps) === "help") return;

  // No argument means $PWD — the one place a default is right, because the question
  // "which domain am I in" is literally about here. Expanded as a plain local path, not
  // as a `[host:]path` location: a reverse lookup is always about this filesystem.
  let path: string;
  try {
    path = expandLocalDomainPath(parsed.positionals[0] ?? deps.cwd(), { home: deps.home(), cwd: deps.cwd() });
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return deps.exit(1);
  }

  const { domain, registered } = await deps.ipcCall("domainWhich", { path });
  if (!domain) {
    // Outside every domain is an error, never a guess: there is no default domain.
    // `--json` still emits parseable JSON on the miss — a consumer that has to distinguish
    // "no domain" from "the command crashed" should not have to parse stderr to do it.
    // The exit code stays 1 either way.
    if (parsed.flags.json) {
      deps.log(JSON.stringify({ path, domain: null, registered }, null, 2));
      return deps.exit(1);
    }
    printError(`${path} is not inside any registered domain`);
    printError(
      registered.length > 0
        ? `Registered domains: ${registered.join(", ")}`
        : "No domains are registered. Use `mcx domain add <name> [host:]<path>`.",
    );
    return deps.exit(1);
  }
  if (parsed.flags.json) {
    deps.log(JSON.stringify(domain, null, 2));
    return;
  }
  deps.log(domain.name);
}

async function domainRename(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain rename <old> <new>";
  const parsed = parseFlags(args, {});
  if (gateFlags(parsed, usage, deps) === "help") return;

  const [from, to] = parsed.positionals;
  if (!from || !to) {
    printError(usage);
    deps.exit(1);
  }

  const domain = await deps.ipcCall("domainRename", { from, to });
  deps.error(`Domain "${from}" renamed to "${domain.name}" (still at ${location(domain)})`);
}

async function domainRm(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain rm <name> [--force]";
  // `--cascade` is the StateDb-level name for the same thing; accepted so the option a
  // reader finds in the daemon's docstring works on the command line too.
  const parsed = parseFlags(args, { force: { type: "boolean" }, cascade: { type: "boolean" } });
  if (gateFlags(parsed, usage, deps) === "help") return;

  const name = parsed.positionals[0];
  if (!name) {
    printError(usage);
    deps.exit(1);
  }
  const cascade = parsed.flags.force === true || parsed.flags.cascade === true;

  const result = await deps.ipcCall("domainRemove", { name, cascade });
  if (!result.found) {
    printError(`No domain named "${name}"`);
    return deps.exit(1);
  }
  if (!result.removed) {
    // `removed: false` with no dependents is not a refusal — it is a concurrent delete
    // between the lookup and the delete. Reporting it as "0 dependent row(s) still
    // reference it" would be nonsense, and would advertise `--force` as the remedy for a
    // domain that is already gone.
    if (result.dependents.length === 0) {
      printError(`Domain "${name}" was removed by something else before this command could remove it`);
      return deps.exit(1);
    }
    const total = result.dependents.reduce((n, d) => n + d.rows, 0);
    printError(`Refusing to remove domain "${name}": ${total} dependent row(s) still reference it`);
    for (const { table, rows } of result.dependents) printError(`  ${table}\t${rows}`);
    // Counts cover rows carrying this domain's `domain_id`. No production writer sets one
    // yet (#3155 tracks them), so today this refusal is reachable only once those land.
    printError("Counts cover rows bound to this domain (domain_id); see #3155 for writer coverage.");
    printError("Reassign or delete them first, or re-run with --force to delete them with the domain.");
    return deps.exit(1);
  }
  const cascaded = result.dependents.reduce((n, d) => n + d.rows, 0);
  deps.error(
    cascaded > 0 ? `Domain "${name}" removed along with ${cascaded} dependent row(s)` : `Domain "${name}" removed`,
  );
}

async function domainImport(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain import [--force]";
  const parsed = parseFlags(args, { force: { type: "boolean" } });
  if (gateFlags(parsed, usage, deps) === "help") return;
  const force = parsed.flags.force === true;

  const result = await deps.ipcCall("domainImport", { force });
  for (const line of result.log) deps.error(line);

  if (!result.armed) {
    printError(`Import not re-armed: ${result.reason ?? "unknown reason"}`);
    if (!force) {
      // The marker lives in the LEGACY database on purpose, so it outlives mcx.db —
      // which is exactly why deleting mcx.db is not a recovery and this flag is.
      printError(
        `The one-shot import marker "${result.markerKey}" is set in the legacy database, where it outlives mcx.db.`,
      );
      printError(result.recovery);
    }
    return deps.exit(1);
  }

  // The import refuses a database that already holds rows, so the removal is required, not
  // advisory. Printing the whole sequence rather than just "restart" is the difference
  // between an instruction that works and the three in this arc's history that did not.
  deps.error(result.recovery);
  // Armed, not imported: the copy runs at the next daemon start, at its one call site,
  // ahead of the reapers and pollers whose work an in-flight import would invalidate.
  deps.error(`Import re-armed: the marker "${result.markerKey}" was cleared from the legacy database.`);
  deps.error("Restart the daemon to run the import: mcx shutdown && mcx status");
}

function printDomainHelp(deps: DomainDeps): void {
  deps.error(`mcx domain — names bound to locations (see docs/domains.md)

Usage:
  mcx domain add <name> [host:]<path>   Register a domain
  mcx domain ls [--json]                List domains
  mcx domain show <name> [--json]       Resolve a domain to host + path
  mcx domain which [path] [--json]      Which domain owns this path? (default: cwd)
  mcx domain rename <old> <new>         Rename; path and every domain_id are untouched
  mcx domain rm <name> [--force]        Remove; refuses while dependent rows exist
                                        (--cascade is an accepted alias for --force)
  mcx domain import --force             Re-arm the one-shot legacy import (clears its
                                        marker; the import runs on the next daemon start,
                                        and refuses unless this database is empty)

Examples:
  mcx domain add phoenix ~/github/phoenix-octovalve
  mcx domain add phoenix boxen0010:~/github/phoenix-octovalve
  mcx domain which`);
}
