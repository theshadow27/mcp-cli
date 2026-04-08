/**
 * `mcx scope` — manage project scopes.
 *
 * Scopes register directory roots by name, stored as JSON files in ~/.mcp-cli/scopes/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { options } from "@mcp-cli/core";
import { printError } from "../output";

export interface ScopeFile {
  root: string;
  created: string;
}

/** Dependency injection for testability */
export interface ScopeDeps {
  cwd: () => string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

const defaultDeps: ScopeDeps = {
  cwd: () => process.cwd(),
};

export function cmdScope(args: string[], deps: ScopeDeps = defaultDeps): void {
  const sub = args[0];

  switch (sub) {
    case "init":
      scopeInit(args.slice(1), deps);
      break;
    case "list":
    case "ls":
      scopeList(deps);
      break;
    case "rm":
    case "remove":
      scopeRm(args.slice(1), deps);
      break;
    default:
      printError("Usage: mcx scope {init|list|rm} [args]");
      process.exit(1);
  }
}

function scopePath(name: string): string {
  return join(options.SCOPES_DIR, `${name}.json`);
}

function readScope(name: string): ScopeFile | null {
  const path = scopePath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ScopeFile;
}

function listAllScopes(): Array<{ name: string; scope: ScopeFile }> {
  if (!existsSync(options.SCOPES_DIR)) return [];
  const entries = readdirSync(options.SCOPES_DIR).filter((f) => f.endsWith(".json"));
  const result: Array<{ name: string; scope: ScopeFile }> = [];
  for (const entry of entries) {
    const name = entry.replace(/\.json$/, "");
    const scope = readScope(name);
    if (scope) result.push({ name, scope });
  }
  return result;
}

function scopeInit(args: string[], deps: ScopeDeps): void {
  const force = args.includes("--force");
  const positional = args.filter((a) => !a.startsWith("-"));
  const cwd = resolve(deps.cwd());
  const name = positional[0] ?? basename(cwd);
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    printError(`Invalid scope name "${name}": must be alphanumeric, hyphens, or underscores`);
    process.exit(1);
  }

  // Check if cwd is already under an existing scope
  const existing = listAllScopes();
  for (const { name: existingName, scope } of existing) {
    const root = resolve(scope.root);
    if (cwd.startsWith(`${root}/`) || cwd === root) {
      error(`Warning: Already under scope "${existingName}" (root: ${root})`);
      break;
    }
  }

  // Check if name already exists
  if (!force && existsSync(scopePath(name))) {
    printError(`Scope "${name}" already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  mkdirSync(options.SCOPES_DIR, { recursive: true });

  const scopeFile: ScopeFile = {
    root: cwd,
    created: new Date().toISOString(),
  };
  writeFileSync(scopePath(name), `${JSON.stringify(scopeFile, null, 2)}\n`);
  log(`Scope "${name}" registered at ${cwd}`);
}

function scopeList(deps: ScopeDeps): void {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const scopes = listAllScopes();

  if (scopes.length === 0) {
    error("No scopes registered. Use `mcx scope init` to create one.");
    return;
  }

  for (const { name, scope } of scopes) {
    log(`  ${name}\t${scope.root}`);
  }
}

function scopeRm(args: string[], deps: ScopeDeps): void {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    printError("Usage: mcx scope rm <name>");
    process.exit(1);
  }

  const path = scopePath(name);
  if (!existsSync(path)) {
    printError(`Scope "${name}" not found`);
    process.exit(1);
  }

  unlinkSync(path);
  (deps.log ?? console.log)(`Scope "${name}" removed`);
}
