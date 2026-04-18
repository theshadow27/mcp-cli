/**
 * `mcx site` — browser-mediated named HTTP calls for web apps.
 *
 * Each subcommand is a thin wrapper over a tool on the `_site` virtual MCP server.
 * See `packages/daemon/src/site/` for config/catalog/browser internals.
 */

import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { SITE_SERVER_NAME } from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { extractJsonFlag } from "../parse";

export interface SiteDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  exit: (code: number) => never;
}

const defaultDeps: SiteDeps = {
  ipcCall: defaultIpcCall,
  log: (m) => console.log(m),
  logError: (m) => console.error(m),
  exit: (c) => process.exit(c) as never,
};

const HELP = `mcx site — browser-mediated named HTTP calls for web apps

Usage:
  mcx sites                               List configured sites (alias for 'mcx site list')
  mcx site list                           List configured sites
  mcx site show <name>                    Show a site's config
  mcx site add <name> --url <u> [...]     Create or update a site
  mcx site remove <name>                  Remove a user-configured site

  mcx site calls <site>                   List named calls in a site's catalog
  mcx site describe <site> <call>         Show a call's definition
  mcx site call <site> <call> [--k v ...] Invoke a named call
  mcx site add-call <site> <name> --url <u> [--method M] [...]
  mcx site remove-call <site> <call>

  mcx site browser [sites...]             Launch browser and open tabs (auth)
  mcx site disconnect                     Stop the browser
  mcx site sniff <site> [--mode M] [--filter RE] [--limit N]
  mcx site wiggle [site]                  Run the site's keep-alive script
  mcx site eval <site> <code>             Evaluate JS in the site's page
  mcx site cold-start [site]              Clear storage and reload

Flags:
  --json, -j       Output raw JSON
  --help, -h       Show this help
`;

function parseKv(args: string[]): { kv: Record<string, unknown>; rest: string[] } {
  const kv: Record<string, unknown> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        kv[k] = coerce(v);
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          kv[key] = true;
        } else {
          kv[key] = coerce(next);
          i++;
        }
      }
    } else {
      rest.push(a);
    }
  }
  return { kv, rest };
}

function coerce(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Extract the first text-content item from an MCP tool result, parsing JSON when possible. */
function unwrap(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
  const first = r?.content?.[0];
  const text = first?.text ?? "";
  if (r?.isError) return { _error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callSiteTool(deps: SiteDeps, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const raw = await deps.ipcCall("callTool", { server: SITE_SERVER_NAME, tool, arguments: args });
  return unwrap(raw);
}

function emit(deps: SiteDeps, data: unknown, json: boolean): void {
  if (data && typeof data === "object" && "_error" in (data as Record<string, unknown>)) {
    deps.logError(String((data as { _error: unknown })._error));
    deps.exit(1);
  }
  if (json || typeof data !== "string") {
    deps.log(JSON.stringify(data, null, 2));
  } else {
    deps.log(data);
  }
}

export async function cmdSite(args: string[], depsOverride?: Partial<SiteDeps>): Promise<void> {
  const deps: SiteDeps = { ...defaultDeps, ...depsOverride };
  const { json, rest: afterJson } = extractJsonFlag(args);

  if (afterJson.length === 0 || afterJson[0] === "help" || afterJson[0] === "--help" || afterJson[0] === "-h") {
    deps.log(HELP);
    return;
  }

  const sub = afterJson[0];
  const subArgs = afterJson.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      emit(deps, await callSiteTool(deps, "site_list", {}), json);
      return;

    case "show": {
      const name = subArgs[0];
      if (!name) return fail(deps, "usage: mcx site show <name>");
      emit(deps, await callSiteTool(deps, "site_show", { name }), json);
      return;
    }

    case "add": {
      const name = subArgs[0];
      if (!name) return fail(deps, "usage: mcx site add <name> --url <url> [--domains a,b,...]");
      const { kv } = parseKv(subArgs.slice(1));
      if (typeof kv.domains === "string") kv.domains = kv.domains.split(",");
      emit(deps, await callSiteTool(deps, "site_add", { name, ...kv }), json);
      return;
    }

    case "remove":
    case "rm": {
      const name = subArgs[0];
      if (!name) return fail(deps, "usage: mcx site remove <name>");
      emit(deps, await callSiteTool(deps, "site_remove", { name }), json);
      return;
    }

    case "calls": {
      const site = subArgs[0];
      if (!site) return fail(deps, "usage: mcx site calls <site>");
      emit(deps, await callSiteTool(deps, "site_calls", { site }), json);
      return;
    }

    case "describe": {
      const site = subArgs[0];
      const call = subArgs[1];
      if (!site || !call) return fail(deps, "usage: mcx site describe <site> <call>");
      emit(deps, await callSiteTool(deps, "site_describe", { site, call }), json);
      return;
    }

    case "call": {
      const site = subArgs[0];
      const call = subArgs[1];
      if (!site || !call) return fail(deps, "usage: mcx site call <site> <call> [--param value ...]");
      const { kv } = parseKv(subArgs.slice(2));
      const { body, ...params } = kv;
      emit(deps, await callSiteTool(deps, "site_call", { site, call, params, body }), json);
      return;
    }

    case "add-call": {
      const site = subArgs[0];
      const name = subArgs[1];
      if (!site || !name)
        return fail(deps, "usage: mcx site add-call <site> <name> --url <u> [--method M] [--description ...]");
      const { kv } = parseKv(subArgs.slice(2));
      emit(deps, await callSiteTool(deps, "site_add_call", { site, name, ...kv }), json);
      return;
    }

    case "remove-call": {
      const site = subArgs[0];
      const call = subArgs[1];
      if (!site || !call) return fail(deps, "usage: mcx site remove-call <site> <call>");
      emit(deps, await callSiteTool(deps, "site_remove_call", { site, call }), json);
      return;
    }

    case "browser": {
      const sites = subArgs.length > 0 ? subArgs : undefined;
      emit(deps, await callSiteTool(deps, "site_browser_start", sites ? { sites } : {}), json);
      return;
    }

    case "disconnect":
    case "stop":
      emit(deps, await callSiteTool(deps, "site_disconnect", {}), json);
      return;

    case "sniff": {
      const site = subArgs[0];
      if (!site) return fail(deps, "usage: mcx site sniff <site> [--mode M] [--filter RE] [--limit N]");
      const { kv } = parseKv(subArgs.slice(1));
      emit(deps, await callSiteTool(deps, "site_sniff", { site, ...kv }), json);
      return;
    }

    case "wiggle": {
      const site = subArgs[0];
      emit(deps, await callSiteTool(deps, "site_wiggle", site ? { site } : {}), json);
      return;
    }

    case "eval": {
      const site = subArgs[0];
      const code = subArgs.slice(1).join(" ");
      if (!site || !code) return fail(deps, "usage: mcx site eval <site> <code>");
      emit(deps, await callSiteTool(deps, "site_eval", { site, code }), json);
      return;
    }

    case "cold-start": {
      const site = subArgs[0];
      emit(deps, await callSiteTool(deps, "site_cold_start", site ? { site } : {}), json);
      return;
    }

    default:
      return fail(deps, `Unknown subcommand: ${sub}\n\n${HELP}`);
  }
}

function fail(deps: SiteDeps, msg: string): void {
  deps.logError(msg);
  deps.exit(1);
}
