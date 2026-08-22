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

/** Report flag-parsing errors and exit, or return the parsed result. */
function requireValidFlags(result: ReturnType<typeof parseFlags>, usage: string, deps: DomainDeps): void {
  if (result.errors.length === 0) return;
  for (const err of result.errors) printError(err);
  printError(usage);
  deps.exit(1);
}

async function domainAdd(args: string[], deps: DomainDeps): Promise<void> {
  const usage = "Usage: mcx domain add <name> [host:]<path>";
  const parsed = parseFlags(args, {});
  requireValidFlags(parsed, usage, deps);

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
  requireValidFlags(parsed, "Usage: mcx domain ls [--json]", deps);

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
  requireValidFlags(parsed, usage, deps);

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
  requireValidFlags(parsed, usage, deps);

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
  requireValidFlags(parsed, usage, deps);

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
  requireValidFlags(parsed, usage, deps);

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
    const total = result.dependents.reduce((n, d) => n + d.rows, 0);
    printError(`Refusing to remove domain "${name}": ${total} dependent row(s) still reference it`);
    for (const { table, rows } of result.dependents) printError(`  ${table}\t${rows}`);
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
  requireValidFlags(parsed, usage, deps);
  const force = parsed.flags.force === true;

  const result = await deps.ipcCall("domainImport", { force });
  for (const line of result.log) deps.error(line);

  if (!result.ran) {
    printError(`Legacy import declined: ${result.reason ?? "unknown reason"}`);
    if (!force) {
      // The marker lives in the LEGACY database on purpose, so it outlives mcx.db —
      // which is exactly why deleting mcx.db is not a recovery and this flag is.
      printError(
        `The one-shot import marker "${result.markerKey}" is set in the legacy database, where it outlives mcx.db.`,
      );
      printError("Re-run the import with: mcx domain import --force");
    }
    return deps.exit(1);
  }

  const notCopied =
    result.totalNotCopied > 0 ? `; ${result.totalNotCopied} row(s) not copied (already present or rejected)` : "";
  deps.error(`Imported ${result.totalCopied} row(s) and ${result.domainsImported} domain(s)${notCopied}`);
  if (!result.sealed) {
    printError(
      `Import did not complete: ${result.failedTables.length} table(s) failed (${result.failedTables.join(", ")}). The marker was withheld, so the import retries on the next daemon start.`,
    );
    return deps.exit(1);
  }
  deps.error("Restart the daemon (`mcx shutdown`) so every subsystem re-reads the imported rows.");
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
  mcx domain import [--force]           Re-run the one-shot import from the legacy state.db

Examples:
  mcx domain add phoenix ~/github/phoenix-octovalve
  mcx domain add phoenix boxen0010:~/github/phoenix-octovalve
  mcx domain which`);
}
