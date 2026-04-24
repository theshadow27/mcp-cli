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
import { SITE_SERVER_NAME } from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserEngine, BrowserEngineName, SiteSpec } from "./site/browser/engine";
import { removeCall as catalogRemoveCall, upsertCall as catalogUpsertCall, loadCatalog } from "./site/catalog";
import {
  type SiteConfig,
  getBuiltinWiggleSource,
  getSite,
  getSiteForDomain,
  listSites,
  resolveSiteAsset,
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
let browser: BrowserEngine | null = null;
let browserEngineName: BrowserEngineName | null = null;
const sitesOpenInBrowser = new Set<string>();

// ── Lazy browser load ──

async function loadBrowser(engine: BrowserEngineName): Promise<BrowserEngine> {
  if (browser && browserEngineName === engine) return browser;
  if (browser && browserEngineName !== engine) {
    throw new Error(
      `Browser already running with engine '${browserEngineName}'. Stop it with site_disconnect before switching to '${engine}'.`,
    );
  }
  if (engine === "playwright") {
    try {
      const mod = await import("./site/browser/playwright");
      browser = new mod.PlaywrightBrowserEngine();
      browserEngineName = "playwright";
      return browser;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND|Module not found/.test(msg)) {
        throw new Error(
          "Playwright is not installed. Sites with browser tools require the optional 'playwright' dependency: run `bun add -D playwright` and retry.",
          { cause: err instanceof Error ? err : undefined },
        );
      }
      throw err;
    }
  }
  throw new Error(`Browser engine '${engine}' is not yet implemented. Use 'playwright'.`);
}

function resolveProfileDir(cfg: SiteConfig): string {
  const raw = cfg.browser?.profileDir;
  if (raw) {
    return raw.startsWith("~/") ? raw.replace("~", homedir()) : raw;
  }
  return siteBrowserProfileDir(cfg.name, cfg.browser?.chromeProfile ?? "default");
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

// ── Tool handlers ──

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

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
  resetIfBrowserDied();
  const site = requireSite(args.site as string);
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
      onWiggle: browser ? async () => void (await browser?.wiggle(site.name)) : undefined,
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

/**
 * If the engine's underlying browser closed unexpectedly (user clicked X,
 * Chrome crashed, network disconnect), PlaywrightBrowserEngine's `ctx.on("close")`
 * listener clears its internal state but nothing notifies this outer module —
 * so `browser` stays truthy while every call fails. Detect and reset.
 */
function resetIfBrowserDied(): void {
  if (browser && !browser.isRunning()) {
    browser = null;
    browserEngineName = null;
    sitesOpenInBrowser.clear();
  }
}

async function handleBrowserStart(args: Record<string, unknown>): Promise<ToolResult> {
  resetIfBrowserDied();
  const siteNames =
    (args.sites as string[] | undefined) ??
    listSites()
      .filter((s) => s.enabled)
      .map((s) => s.name);
  const sites = siteNames.map((n) => requireSite(n));
  if (sites.length === 0) return error("No sites configured");

  const engine = (sites[0].browser?.engine ?? "playwright") as BrowserEngineName;
  // Per-site engine mixing isn't supported in one context. Flag it clearly.
  for (const s of sites) {
    if ((s.browser?.engine ?? "playwright") !== engine) {
      return error(
        `All sites opened in one browser must use the same engine. Mixed: ${engine} vs ${s.browser?.engine}`,
      );
    }
    sniffer.configureSite(s.name, s.captureMode ?? "firehose", s.captureFilters);
  }

  const eng = await loadBrowser(engine);
  const specs = sites.map(siteSpecFor);
  const startResults = await eng.start(specs, sniffer.asEvents());
  for (const s of sites) sitesOpenInBrowser.add(s.name);

  return ok({ ok: true, engine, sites: eng.getSiteNames(), results: startResults });
}

async function handleDisconnect(): Promise<ToolResult> {
  resetIfBrowserDied();
  if (!browser) return ok({ ok: true, note: "browser was not running" });
  await browser.stop();
  browser = null;
  browserEngineName = null;
  sitesOpenInBrowser.clear();
  return ok({ ok: true });
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

async function handleWiggle(args: Record<string, unknown>): Promise<ToolResult> {
  resetIfBrowserDied();
  if (!browser) return error("Browser is not running. Start it with site_browser_start.");
  const site = args.site as string | undefined;
  const touched = await browser.wiggle(site);
  return ok({ ok: true, touched });
}

async function handleEval(args: Record<string, unknown>): Promise<ToolResult> {
  resetIfBrowserDied();
  if (!browser) return error("Browser is not running. Start it with site_browser_start.");
  const code = args.code as string;
  if (!code) return error("Missing 'code'");
  const site = args.site as string | undefined;
  return ok({ result: await browser.evalInPage(code, site) });
}

async function handleColdStart(args: Record<string, unknown>): Promise<ToolResult> {
  resetIfBrowserDied();
  if (!browser) return error("Browser is not running. Start it with site_browser_start.");
  const site = args.site as string | undefined;
  return ok(await browser.coldStart(site));
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
void sitesOpenInBrowser;

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
