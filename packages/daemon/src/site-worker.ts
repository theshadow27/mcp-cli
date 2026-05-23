/**
 * Bun Worker hosting the `_site` virtual MCP server.
 *
 * Sites are web-app targets with per-site named-call catalogs, credential
 * vaults, and optional browser-mediated auth. Pure-HTTP tools run without
 * touching the browser. The browser engine (Playwright today) is loaded only
 * via dynamic import the first time a browser-dependent tool is invoked —
 * this keeps `mcpd` startup fast and Playwright off the hot path for users
 * who never configure a site.
 *
 * Protocol:
 *   1. Parent sends: { type: "init" }
 *   2. Worker starts MCP Server, responds: { type: "ready" }
 *   3. Parent sends MCP JSON-RPC messages (via WorkerClientTransport)
 *   4. Worker sends MCP JSON-RPC responses back
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { SITE_SERVER_NAME } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserHandlers, toolError as error, toolOk as ok, shouldAutoRestart } from "./site/browser-handlers";
import type { ToolResult } from "./site/browser-handlers";
export { shouldAutoRestart, parseSitesArg } from "./site/browser-handlers";
export type { LastBrowserSession } from "./site/browser-handlers";
import type { SiteSpec } from "./site/browser/engine";
import { removeCall as catalogRemoveCall, upsertCall as catalogUpsertCall, loadCatalog } from "./site/catalog";
import {
  type SiteConfig,
  getBuiltinWiggleSource,
  getSite,
  getSiteForDomain,
  listSites,
  resolveSiteAsset,
  validateProfileDir,
  validateSiteName,
  writeSiteConfig,
} from "./site/config";
import { CredentialVault, summarizeCredential } from "./site/credentials";
import { siteBrowserProfileDir, sitePath } from "./site/paths";
import { proxyCall } from "./site/proxy";
import { resolve as resolveCall } from "./site/resolver";
import { Sniffer } from "./site/sniffer";
import { SITE_TOOLS, SITE_TOOL_NAMES } from "./site/tools";
import { applyFetchFilter, applyJqInput, applyJqOutput } from "./site/transforms";
import { createIsControlMessage } from "./worker-control-message";
import { WorkerServerTransport } from "./worker-transport";

void shouldAutoRestart; // re-exported above; suppress unused warning

// ── Control messages ──

interface InitMessage {
  type: "init";
  daemonId?: string;
}

interface ToolsChangedMessage {
  type: "tools_changed";
}

type ControlMessage = InitMessage | ToolsChangedMessage;
const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set<ControlMessage["type"]>(["init", "tools_changed"]);
const isControlMessage = createIsControlMessage<ControlMessage>(CONTROL_MESSAGE_TYPES);

declare const self: Worker;

let mcpServer: Server | null = null;
let transport: WorkerServerTransport | null = null;

// ── Runtime singletons ──

const vault = new CredentialVault();
const sniffer = new Sniffer(vault);

// ── Helpers for siteSpecFor ──

function resolveProfileDir(cfg: SiteConfig): string {
  const raw = cfg.browser?.profileDir;
  if (raw) {
    validateProfileDir(raw);
    const expanded = raw.startsWith("~/") ? raw.replace("~", homedir()) : raw;
    return resolvePath(expanded);
  }
  const profile = cfg.browser?.chromeProfile ?? "default";
  if (/[/\\]/.test(profile) || profile.split("/").some((seg) => seg === "..")) {
    throw new Error(
      `browser.chromeProfile must be a simple directory name with no path separators or ..; got: ${profile}`,
    );
  }
  return siteBrowserProfileDir(cfg.name, profile);
}

function siteSpecFor(cfg: SiteConfig): SiteSpec {
  const seedName = cfg.seed ?? cfg.name;
  const wiggleRel = cfg.wiggle;
  const wigglePath = wiggleRel ? resolveSiteAsset(cfg.name, wiggleRel) : null;
  return {
    name: cfg.name,
    url: cfg.url,
    blockProtocols: cfg.blockProtocols,
    profileDir: resolveProfileDir(cfg),
    wigglePath: wigglePath ?? undefined,
    wiggleSrc: getBuiltinWiggleSource(seedName) ?? undefined,
  };
}

function requireSite(name: string): SiteConfig {
  const s = getSite(name);
  if (!s) throw new Error(`Unknown site: ${name}`);
  return s;
}

// ── Browser handler factory ──
// Production instance: uses real playwright + real site config.

const browserHandlers = createBrowserHandlers({
  getSiteFn: getSite,
  listSitesFn: listSites,
  siteSpecForFn: siteSpecFor,
  sniffer,
});

const {
  handleBrowserStart,
  handleDisconnect,
  handleWiggle,
  handleEval,
  handleColdStart,
  snapshotBrowser,
  tryAutoRestartBrowser,
  getLastBrowserSession,
} = browserHandlers;

// ── Tool handlers ──

function handleList(): ToolResult {
  return ok(
    listSites().map((s) => ({ name: s.name, url: s.url, enabled: s.enabled, engine: s.browser?.engine, seed: s.seed })),
  );
}

function handleShow(args: Record<string, unknown>): ToolResult {
  const name = args.name as string;
  const site = getSite(name);
  if (!site) return error(`Unknown site: ${name}`);
  return ok(site);
}

function handleAdd(args: Record<string, unknown>): ToolResult {
  const name = args.name as string;
  try {
    validateSiteName(name);
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
  const existing = getSite(name);
  const { name: _omit, ...existingWithoutName } = existing ?? {};
  const merged: Record<string, unknown> = {
    ...existingWithoutName,
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.domains !== undefined ? { domains: args.domains } : {}),
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    ...(args.captureMode !== undefined ? { captureMode: args.captureMode } : {}),
    ...(args.blockProtocols !== undefined ? { blockProtocols: args.blockProtocols } : {}),
    ...(args.wiggle !== undefined ? { wiggle: args.wiggle } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
  };
  if (args.browserEngine !== undefined || args.chromeProfile !== undefined || args.profileDir !== undefined) {
    merged.browser = {
      ...(existing?.browser ?? {}),
      ...(args.browserEngine !== undefined ? { engine: args.browserEngine } : {}),
      ...(args.chromeProfile !== undefined ? { chromeProfile: args.chromeProfile } : {}),
      ...(args.profileDir !== undefined ? { profileDir: args.profileDir } : {}),
    };
  }
  writeSiteConfig(name, merged);
  return ok({ ok: true, site: getSite(name) });
}

function handleRemove(args: Record<string, unknown>): ToolResult {
  const name = args.name as string;
  try {
    validateSiteName(name);
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
  const dir = sitePath(name);
  if (!existsSync(dir)) return error(`Site '${name}' has no user directory`);
  rmSync(dir, { recursive: true, force: true });
  return ok({ ok: true, removed: name });
}

function handleCalls(args: Record<string, unknown>): ToolResult {
  const site = requireSite(args.site as string);
  const catalog = loadCatalog(site.name, site.seed ?? site.name);
  return ok(
    Object.values(catalog).map((c) => ({ name: c.name, method: c.method, url: c.url, description: c.description })),
  );
}

function handleDescribe(args: Record<string, unknown>): ToolResult {
  const site = requireSite(args.site as string);
  const catalog = loadCatalog(site.name, site.seed ?? site.name);
  const call = catalog[args.call as string];
  if (!call) return error(`Unknown call '${args.call}' for site '${site.name}'`);
  return ok(call);
}

async function handleCall(args: Record<string, unknown>): Promise<ToolResult> {
  let browserSnapshot = await snapshotBrowser();
  const site = requireSite(args.site as string);

  // Auto-restart if the browser died (e.g. system sleep) and the vault is empty for this site.
  // This avoids the confusing "No credentials available" error when the Chrome profile is intact.
  if (shouldAutoRestart(getLastBrowserSession(), vault.getAll(site.name).length === 0)) {
    const restarted = await tryAutoRestartBrowser();
    if (restarted) browserSnapshot = await snapshotBrowser();
  }
  const callName = args.call as string;
  const catalog = loadCatalog(site.name, site.seed ?? site.name);
  const call = catalog[callName];
  if (!call) return error(`Unknown call '${callName}' for site '${site.name}'`);

  const params = (args.params as Record<string, unknown>) ?? {};
  const rawBody = args.body as string | undefined;

  let resolved: ReturnType<typeof resolveCall>;
  try {
    resolved = resolveCall(call, params, rawBody);
    resolved = await applyJqInput(call, params, resolved);
    resolved = applyFetchFilter(call, resolved);
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }

  try {
    let result = await proxyCall(vault, {
      site: site.name,
      resolved,
      audHints: call.audHints,
      onWiggle: browserSnapshot
        ? async () => {
            const current = await snapshotBrowser();
            if (current) await current.wiggle(site.name);
          }
        : undefined,
    });
    result = await applyJqOutput(call, result);
    return ok(result);
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}

function handleAddCall(args: Record<string, unknown>): ToolResult {
  const site = requireSite(args.site as string);
  const name = args.name as string;
  const url = args.url as string;
  if (!name || !url) return error("Missing 'name' or 'url'");
  const call = {
    name,
    url,
    method: ((args.method as string) ?? "GET").toUpperCase(),
    description: args.description as string | undefined,
    headers: args.headers as Record<string, string> | undefined,
    audHints: args.audHints as string[] | undefined,
  };
  catalogUpsertCall(site.name, call, site.seed ?? site.name);
  return ok({ ok: true, call });
}

function handleRemoveCall(args: Record<string, unknown>): ToolResult {
  const site = requireSite(args.site as string);
  const removed = catalogRemoveCall(site.name, args.call as string, site.seed ?? site.name);
  return ok({ ok: true, removed });
}

function handleSniff(args: Record<string, unknown>): ToolResult {
  const site = requireSite(args.site as string);
  if (args.mode !== undefined) {
    const mode = args.mode as "off" | "filtered" | "firehose";
    sniffer.setMode(site.name, mode);
  }
  const filter = args.filter as string | undefined;
  const limit = (args.limit as number | undefined) ?? 50;
  return ok({
    site: site.name,
    mode: sniffer.getMode(site.name),
    recentRequests: sniffer
      .getRecentRequests(filter)
      .filter((r) => r.site === site.name)
      .slice(-limit),
    recentResponses: sniffer
      .getRecentResponses(filter)
      .filter((r) => r.site === site.name)
      .slice(-limit),
    recentWsFrames: sniffer
      .getRecentWsFrames(filter)
      .filter((r) => r.site === site.name)
      .slice(-limit),
    credentials: vault.getAll(site.name).map(summarizeCredential),
  });
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!SITE_TOOL_NAMES.has(name)) return error(`Unknown tool: ${name}`);
  try {
    switch (name) {
      case "site_list":
        return handleList();
      case "site_show":
        return handleShow(args);
      case "site_add":
        return handleAdd(args);
      case "site_remove":
        return handleRemove(args);
      case "site_calls":
        return handleCalls(args);
      case "site_describe":
        return handleDescribe(args);
      case "site_call":
        return await handleCall(args);
      case "site_add_call":
        return handleAddCall(args);
      case "site_remove_call":
        return handleRemoveCall(args);
      case "site_browser_start":
        return await handleBrowserStart(args);
      case "site_disconnect":
        return await handleDisconnect();
      case "site_sniff":
        return handleSniff(args);
      case "site_wiggle":
        return await handleWiggle(args);
      case "site_eval":
        return await handleEval(args);
      case "site_cold_start":
        return await handleColdStart(args);
      default:
        return error(`Unhandled tool: ${name}`);
    }
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}

// Silence unused warnings for helpers that will be wired up when mcx auth integration lands (#1454 follow-up).
void getSiteForDomain;

// ── Server startup ──

async function startServer(): Promise<void> {
  mcpServer = new Server({ name: SITE_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: SITE_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatch(name, args ?? {});
  });

  transport = new WorkerServerTransport(self);
  await mcpServer.connect(transport);

  const transportHandler = self.onmessage;
  self.onmessage = async (event: MessageEvent): Promise<void> => {
    const data = event.data;
    if (isControlMessage(data)) {
      if (data.type === "tools_changed") {
        await mcpServer?.notification({ method: "notifications/tools/list_changed" });
      }
      return;
    }
    transportHandler?.call(self, event);
  };
}

// ── Initial message handler ──

self.onmessage = async (event: MessageEvent): Promise<void> => {
  const data = event.data;
  if (isControlMessage(data) && data.type === "init") {
    try {
      await startServer();
      self.postMessage({ type: "ready" });
    } catch (err) {
      mcpServer = null;
      transport = null;
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: "error", message });
    }
  }
};
