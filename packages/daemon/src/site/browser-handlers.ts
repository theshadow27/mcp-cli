/**
 * Browser handler factory: encapsulates the mutable browser state machine so
 * that handlers (handleBrowserStart, handleWiggle, …) can be unit-tested with
 * an injectable BrowserEngine without module-level global state. See #1706.
 */

import { createBrowserLock, withDeadline } from "./browser-lock";
import type { BrowserEngine, BrowserEngineName, BrowserEvents, SiteSpec, StartSiteResult } from "./browser/engine";
import type { CaptureFilters } from "./config";
import type { CaptureMode } from "./sniffer";

// ── Shared result type ──

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function toolOk(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ── Types ──

export interface LastBrowserSession {
  engine: BrowserEngineName;
  /** Site names that were open in the browser. */
  siteNames: string[];
}

export function shouldAutoRestart(session: LastBrowserSession | null, vaultEmpty: boolean): boolean {
  return session !== null && vaultEmpty;
}

// ── parseSitesArg ──

const SITES_ARG_ERROR = "'sites' must be a non-empty array of site name strings";

/** Validates and returns the `sites` argument as a dense, non-empty string array, or an error string. */
export function parseSitesArg(sites: unknown): string[] | string {
  if (!Array.isArray(sites)) return SITES_ARG_ERROR;
  if (sites.length === 0) return SITES_ARG_ERROR;
  for (let i = 0; i < sites.length; i++) {
    if (!(i in sites)) return SITES_ARG_ERROR;
  }
  if (!sites.every((s) => typeof s === "string")) return SITES_ARG_ERROR;
  return sites as string[];
}

// ── Injectable deps ──

/** Minimal site config shape needed by the browser handlers. */
export interface SiteConfigLike {
  name: string;
  enabled?: boolean;
  captureMode?: "off" | "filtered" | "firehose";
  captureFilters?: CaptureFilters;
  browser?: { engine?: string };
}

export interface BrowserHandlerDeps<S extends SiteConfigLike = SiteConfigLike> {
  /**
   * Override the engine factory. When provided, `createBrowserHandlers` calls
   * this instead of the dynamic-import playwright path — used in tests to inject
   * a controllable fake engine without `mock.module()`.
   */
  loadBrowserFn?: (engine: BrowserEngineName) => Promise<BrowserEngine>;
  getSiteFn: (name: string) => S | null;
  listSitesFn: () => S[];
  siteSpecForFn: (cfg: S) => SiteSpec;
  sniffer: {
    configureSite(site: string, mode: CaptureMode, filters?: CaptureFilters): void;
    asEvents(): BrowserEvents;
  };
}

// ── Factory ──

export function createBrowserHandlers<S extends SiteConfigLike = SiteConfigLike>(deps: BrowserHandlerDeps<S>) {
  const { loadBrowserFn, getSiteFn, listSitesFn, siteSpecForFn, sniffer } = deps;

  const withBrowserLock = createBrowserLock();
  let browser: BrowserEngine | null = null;
  let browserEngineName: BrowserEngineName | null = null;
  let lastBrowserSession: LastBrowserSession | null = null;

  function resetIfBrowserDied(): void {
    if (browser && !browser.isRunning()) {
      browser = null;
      browserEngineName = null;
    }
  }

  async function loadBrowserInternal(engine: BrowserEngineName): Promise<BrowserEngine> {
    if (browser && browserEngineName === engine) return browser;
    if (browser && browserEngineName !== engine) {
      throw new Error(
        `Browser already running with engine '${browserEngineName}'. Stop it with site_disconnect before switching to '${engine}'.`,
      );
    }
    if (loadBrowserFn) return loadBrowserFn(engine);
    if (engine === "playwright") {
      try {
        const mod = await import("./browser/playwright");
        return new mod.PlaywrightBrowserEngine();
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

  async function snapshotBrowser(): Promise<BrowserEngine | null> {
    return withBrowserLock(async () => {
      resetIfBrowserDied();
      return browser;
    }, "snapshotBrowser");
  }

  async function tryAutoRestartBrowser(): Promise<boolean> {
    const locked = await withBrowserLock(async () => {
      resetIfBrowserDied();
      if (browser) return null;
      if (!lastBrowserSession) return false as false;

      const { engine, siteNames } = lastBrowserSession;
      const configs: S[] = [];
      for (const name of siteNames) {
        const s = getSiteFn(name);
        if (s) configs.push(s);
      }
      if (configs.length === 0) return false as false;

      for (const s of configs) {
        sniffer.configureSite(s.name, s.captureMode ?? "firehose", s.captureFilters);
      }

      const eng = await loadBrowserInternal(engine);
      const specs = configs.map(siteSpecForFn);

      try {
        await withDeadline(60_000, "browser auto-restart", eng.start(specs, sniffer.asEvents()));
      } catch {
        await withDeadline(5_000, "browser stop on failed auto-restart", eng.stop()).catch((e) =>
          console.warn("[browser] stop failed after auto-restart failure:", e),
        );
        return false as false;
      }

      browser = eng;
      browserEngineName = engine;

      return { eng, configs };
    }, "tryAutoRestartBrowser");

    if (locked === false) return false;
    if (locked === null) return true;

    const { eng, configs } = locked;
    for (const s of configs) {
      try {
        await withDeadline(15_000, "wiggle on auto-restart", eng.wiggle(s.name));
      } catch {
        // Best-effort — vault may also repopulate from background page activity.
      }
    }
    return true;
  }

  async function handleBrowserStart(args: Record<string, unknown>): Promise<ToolResult> {
    return withBrowserLock(async () => {
      resetIfBrowserDied();
      let siteNames: string[];
      if ("sites" in args) {
        const result = parseSitesArg(args.sites);
        if (typeof result === "string") return toolError(result);
        siteNames = result;
      } else {
        siteNames = listSitesFn()
          .filter((s) => s.enabled)
          .map((s) => s.name);
      }
      const sites = siteNames.map((n) => {
        const s = getSiteFn(n);
        if (!s) throw new Error(`Unknown site: ${n}`);
        return s;
      });
      if (sites.length === 0) return toolError("No sites configured");

      const engine = (sites[0].browser?.engine ?? "playwright") as BrowserEngineName;
      for (const s of sites) {
        if ((s.browser?.engine ?? "playwright") !== engine) {
          return toolError(
            `All sites opened in one browser must use the same engine. Mixed: ${engine} vs ${s.browser?.engine}`,
          );
        }
        sniffer.configureSite(s.name, s.captureMode ?? "firehose", s.captureFilters);
      }

      const eng = await loadBrowserInternal(engine);
      const specs = sites.map(siteSpecForFn);
      let startResults: StartSiteResult[];
      try {
        startResults = await withDeadline(60_000, "browser start", eng.start(specs, sniffer.asEvents()));
      } catch (err) {
        await withDeadline(5_000, "browser stop on failed start", eng.stop()).catch((e) =>
          console.warn("[browser] stop failed after start failure:", e),
        );
        throw err;
      }
      browser = eng;
      browserEngineName = engine;
      lastBrowserSession = { engine, siteNames: sites.map((s) => s.name) };

      return toolOk({ ok: true, engine, sites: eng.getSiteNames(), results: startResults });
    }, "handleBrowserStart");
  }

  async function handleDisconnect(): Promise<ToolResult> {
    return withBrowserLock(async () => {
      resetIfBrowserDied();
      if (!browser) return toolOk({ ok: true, note: "browser was not running" });
      await withDeadline(30_000, "browser stop", browser.stop());
      browser = null;
      browserEngineName = null;
      lastBrowserSession = null;
      return toolOk({ ok: true });
    }, "handleDisconnect");
  }

  async function handleWiggle(args: Record<string, unknown>): Promise<ToolResult> {
    const snapshot = await snapshotBrowser();
    if (!snapshot) {
      return toolError(
        lastBrowserSession
          ? "Browser session was dropped (system sleep or crash). Run 'mcx site browser' to re-attach — login is usually not required as your browser profile is preserved on disk."
          : "Browser is not running. Start it with site_browser_start.",
      );
    }
    const site = args.site as string | undefined;
    const touched = await snapshot.wiggle(site);
    return toolOk({ ok: true, touched });
  }

  async function handleEval(args: Record<string, unknown>): Promise<ToolResult> {
    const snapshot = await snapshotBrowser();
    if (!snapshot) return toolError("Browser is not running. Start it with site_browser_start.");
    const code = args.code as string;
    if (!code) return toolError("Missing 'code'");
    const site = args.site as string | undefined;
    return toolOk({ result: await snapshot.evalInPage(code, site) });
  }

  async function handleColdStart(args: Record<string, unknown>): Promise<ToolResult> {
    const snapshot = await snapshotBrowser();
    if (!snapshot) return toolError("Browser is not running. Start it with site_browser_start.");
    const site = args.site as string | undefined;
    return toolOk(await snapshot.coldStart(site));
  }

  function getLastBrowserSession(): LastBrowserSession | null {
    return lastBrowserSession;
  }

  return {
    handleBrowserStart,
    handleDisconnect,
    handleWiggle,
    handleEval,
    handleColdStart,
    snapshotBrowser,
    tryAutoRestartBrowser,
    getLastBrowserSession,
  };
}
