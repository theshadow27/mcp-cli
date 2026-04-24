/**
 * Playwright-backed BrowserEngine adapter.
 *
 * Launches a single persistent Chrome context with one tab per configured
 * site. Requests, responses, and WebSocket frames are forwarded to
 * BrowserEvents so the credential vault + sniffer can observe them.
 *
 * IMPORTANT: this file is only imported via dynamic `import()` inside the
 * site-worker. Static imports would force every daemon startup to load
 * Playwright's heavy binding module. See `../../site-worker.ts`.
 */

import { existsSync, mkdirSync } from "node:fs";
import type {
  BrowserContext,
  Page,
  Request as PwRequest,
  Response as PwResponse,
  WebSocket as PwWebSocket,
} from "playwright";
import type {
  BrowserEngine,
  BrowserEvents,
  CapturedRequest,
  CapturedResponse,
  ColdStartResult,
  SiteSpec,
  StartSiteResult,
} from "./engine";
import { resolvePlaywright } from "./resolve-playwright";

function isTextual(contentType: string): boolean {
  if (!contentType) return true;
  return (
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("form")
  );
}

/**
 * Minimal BrowserContext surface used by {@link openSitesInContext}. Exists so
 * the loop can be unit-tested against fakes without spawning real Chromium.
 */
export interface OpenCtxLike {
  newPage(): Promise<OpenPageLike>;
}

export interface OpenPageLike {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  bringToFront(): Promise<void>;
}

/**
 * Partition requested sites into three buckets for an already-running browser.
 * Exported for unit tests.
 *
 * - alreadyRunning: already has a tab open
 * - toOpen: new site whose profileDir matches the running browser's profileDir
 * - profileMismatch: new site with a different profileDir (needs disconnect first)
 */
export function partitionSitesForRunningBrowser(
  runningProfile: string,
  openedSiteNames: ReadonlySet<string>,
  requested: SiteSpec[],
): { alreadyRunning: SiteSpec[]; toOpen: SiteSpec[]; profileMismatch: SiteSpec[] } {
  const alreadyRunning: SiteSpec[] = [];
  const toOpen: SiteSpec[] = [];
  const profileMismatch: SiteSpec[] = [];
  for (const s of requested) {
    if (openedSiteNames.has(s.name)) {
      alreadyRunning.push(s);
    } else if (s.profileDir !== runningProfile) {
      profileMismatch.push(s);
    } else {
      toOpen.push(s);
    }
  }
  return { alreadyRunning, toOpen, profileMismatch };
}

/**
 * Open a fresh tab per site and navigate it. Exported for unit tests.
 *
 * Why fresh tabs: reusing `ctx.pages()` picks up tabs restored from the
 * persistent Chrome profile, which leaves the user staring at a blank
 * foreground tab while navigation happens off-screen (#1588).
 *
 * The first site is brought to front so the user sees something load.
 * Navigation errors are recorded per site and do not abort the loop.
 */
export async function openSitesInContext<P extends OpenPageLike>(
  ctx: { newPage(): Promise<P> },
  sites: SiteSpec[],
  onPage: (page: P, siteName: string) => void,
): Promise<StartSiteResult[]> {
  const results: StartSiteResult[] = [];
  for (const [i, s] of sites.entries()) {
    const page = await ctx.newPage();
    onPage(page, s.name);

    try {
      await page.goto(s.url, { waitUntil: "domcontentloaded" });
      results.push({ site: s.name, url: s.url, status: "navigated" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[site] goto failed site=${s.name} url=${s.url}: ${message}`);
      results.push({ site: s.name, url: s.url, status: "failed", error: message });
    }
    if (i === 0) {
      try {
        await page.bringToFront();
      } catch {
        // Window may have been closed during navigation; non-fatal.
      }
    }
  }
  return results;
}

export class PlaywrightBrowserEngine implements BrowserEngine {
  private context: BrowserContext | null = null;
  private pages = new Map<string, Page>();
  private siteSpecs = new Map<string, SiteSpec>();
  /** Serializes browser calls to avoid cross-interleaved operations on the same page. */
  private lock: Promise<unknown> = Promise.resolve();
  private events: BrowserEvents = {};

  async start(sites: SiteSpec[], events: BrowserEvents): Promise<StartSiteResult[]> {
    if (this.context) {
      const runningProfile = [...this.siteSpecs.values()][0]?.profileDir ?? "";
      const openedNames = new Set(this.pages.keys());
      const { alreadyRunning, toOpen, profileMismatch } = partitionSitesForRunningBrowser(
        runningProfile,
        openedNames,
        sites,
      );

      const results: StartSiteResult[] = [
        ...alreadyRunning.map((s) => ({
          site: s.name,
          url: this.pages.get(s.name)?.url() ?? s.url,
          status: "already-running" as const,
        })),
        ...profileMismatch.map((s) => ({
          site: s.name,
          url: s.url,
          status: "profile-mismatch" as const,
          error: `Browser is running with profileDir=${runningProfile}; this site uses ${s.profileDir}. Run \`mcx site disconnect\` first.`,
        })),
      ];

      if (toOpen.length > 0) {
        for (const s of toOpen) this.siteSpecs.set(s.name, s);
        const newResults = await openSitesInContext(this.context, toOpen, (page, name) => {
          this.pages.set(name, page);
          this.attachListeners(page, name);
        });
        results.push(...newResults);
      }

      return results;
    }
    this.events = events;
    for (const s of sites) this.siteSpecs.set(s.name, s);

    if (sites.length === 0) throw new Error("PlaywrightBrowserEngine.start: at least one site is required");

    // A single persistent Playwright context has exactly one user-data directory.
    // Sites opened together must agree on profileDir; mixed profiles need separate start() calls.
    const profileDirs = [...new Set(sites.map((s) => s.profileDir))];
    if (profileDirs.length > 1) {
      throw new Error(
        `PlaywrightBrowserEngine.start: all sites opened together must share one profileDir. Got ${profileDirs.length}: ${profileDirs.join(", ")}`,
      );
    }
    const profileDir = profileDirs[0];
    mkdirSync(profileDir, { recursive: true });

    const chromium = await resolvePlaywright();
    const ctx = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    });
    this.context = ctx;

    const blockedPatterns: RegExp[] = [];
    for (const s of sites) {
      for (const proto of s.blockProtocols ?? []) {
        // Normalize "msteams://" / "msteams:" → "msteams", then build a regex that
        // matches both the colon-only and the colon-slash-slash forms.
        const normalized = proto.replace(/:\/\/$/, "").replace(/:$/, "");
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        blockedPatterns.push(new RegExp(`^${escaped}:(?:\\/\\/)?`));
      }
    }
    if (blockedPatterns.length > 0) {
      await ctx.route("**/*", async (route) => {
        const url = route.request().url();
        if (blockedPatterns.some((re) => re.test(url))) {
          await route.abort();
          return;
        }
        await route.continue();
      });
    }

    // If the user closes the browser window without going through stop(), the
    // Playwright context disconnects. Clear our handles so a subsequent start()
    // launches a fresh browser instead of silently no-op'ing on a dead context.
    ctx.on("close", () => {
      if (this.context === ctx) {
        this.context = null;
        this.pages.clear();
        this.siteSpecs.clear();
        this.events = {};
      }
    });

    const results = await openSitesInContext(ctx, sites, (page, name) => {
      this.pages.set(name, page);
      this.attachListeners(page, name);
    });
    return results;
  }

  private attachListeners(page: Page, siteName: string): void {
    page.on("request", (req: PwRequest) => {
      try {
        const captured: CapturedRequest = {
          url: req.url(),
          method: req.method(),
          headers: req.headers(),
          postData: req.postData() ?? null,
          resourceType: req.resourceType(),
        };
        this.events.onRequest?.(siteName, captured);
      } catch {
        // Never let listener errors propagate into the page.
      }
    });

    page.on("response", (resp: PwResponse) => {
      void this.handleResponse(resp, siteName);
    });

    page.on("websocket", (ws: PwWebSocket) => {
      const wsUrl = ws.url();
      const forward = (direction: "tx" | "rx", payload: string | Buffer): void => {
        try {
          const payloadStr = typeof payload === "string" ? payload : payload.toString("utf-8");
          const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
          this.events.onWsFrame?.(siteName, { wsUrl, direction, bytes, payload: payloadStr });
        } catch {
          // Ignore — capture is best-effort.
        }
      };
      ws.on("framesent", (d) => forward("tx", d.payload));
      ws.on("framereceived", (d) => forward("rx", d.payload));
    });
  }

  private async handleResponse(resp: PwResponse, siteName: string): Promise<void> {
    try {
      const req = resp.request();
      const headers = resp.headers();
      const contentType = headers["content-type"] ?? "";
      const textual = isTextual(contentType);

      let bodyText: string | null = null;
      let bodyBytes = 0;
      try {
        if (textual) {
          const buf = await resp.body();
          bodyBytes = buf.length;
          bodyText = buf.toString("utf-8");
        } else {
          const buf = await resp.body().catch(() => Buffer.alloc(0));
          bodyBytes = buf.length;
        }
      } catch {
        // Body may be unavailable on redirects/cancelled requests — keep metadata.
      }

      const captured: CapturedResponse = {
        url: resp.url(),
        method: req.method(),
        status: resp.status(),
        contentType,
        headers,
        bodyBytes,
        bodyText,
        requestHeaders: req.headers(),
        requestPostData: req.postData() ?? null,
      };
      this.events.onResponse?.(siteName, captured);
    } catch {
      // Never propagate capture errors.
    }
  }

  async stop(): Promise<void> {
    if (!this.context) return;
    try {
      await this.context.close();
    } catch {
      // Context may already be dead.
    }
    this.context = null;
    this.pages.clear();
    this.siteSpecs.clear();
    this.events = {};
  }

  isRunning(): boolean {
    return this.context !== null;
  }

  getSiteNames(): string[] {
    return [...this.pages.keys()];
  }

  private async withPage<T>(site: string | undefined, fn: (page: Page) => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      if (!this.context) throw new Error("Browser not started");
      let page: Page | undefined;
      if (site) page = this.pages.get(site);
      if (!page) {
        if (this.pages.size === 1) {
          page = this.pages.values().next().value;
        } else {
          page = this.context.pages()[0] ?? (await this.context.newPage());
        }
      }
      if (!page) throw new Error("No browser page available");
      return await fn(page);
    } finally {
      release();
    }
  }

  async coldStart(site?: string): Promise<ColdStartResult> {
    const cleared: string[] = [];
    await this.withPage(site, async (page) => {
      const origin = new URL(page.url()).origin;
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Storage.clearDataForOrigin", {
          origin,
          storageTypes:
            "appcache,cache_storage,file_systems,indexeddb,local_storage,service_workers,shader_cache,websql,cachestorage",
        });
        cleared.push(`storage-for-origin:${origin}`);
      } catch {
        // clearDataForOrigin is best-effort.
      }
      try {
        await page.evaluate(() => {
          try {
            window.localStorage.clear();
          } catch {
            /* localStorage may be blocked by the page */
          }
          try {
            window.sessionStorage.clear();
          } catch {
            /* sessionStorage may be blocked */
          }
        });
        cleared.push("window-storage");
      } catch {
        // evaluate may fail mid-navigation.
      }
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
      } catch {
        // Reload is best-effort.
      }
    });
    return { cleared, reloaded: true };
  }

  async wiggle(site?: string): Promise<string[]> {
    const siteName = site ?? [...this.pages.keys()][0];
    if (!siteName) return ["no-site"];

    const spec = this.siteSpecs.get(siteName);
    const wigglePath = spec?.wigglePath;

    if (wigglePath && existsSync(wigglePath)) {
      // User-override file on disk — fresh-require so edits take effect without restart.
      try {
        delete require.cache[require.resolve(wigglePath)];
      } catch {
        // Non-CJS resolvers may not populate require.cache — that's fine.
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported: unknown = require(wigglePath);
      const wiggleFn = ((exported as Record<string, unknown>)?.default ?? exported) as unknown;
      if (typeof wiggleFn !== "function") throw new Error(`wiggle module at '${wigglePath}' must export a function`);
      return this.withPage(site, (page) => (wiggleFn as (page: Page) => Promise<string[]>)(page));
    }

    if (spec?.wiggleSrc) {
      // Embedded seed script — evaluate CJS source from compiled binary.
      // Constraint: require(), __dirname, and __filename are NOT injected — wiggle scripts must be self-contained.
      const mod = { exports: {} as Record<string, unknown> };
      new Function("module", "exports", "process", spec.wiggleSrc)(mod, mod.exports, process);
      const exported: unknown = mod.exports;
      const wiggleFn = ((exported as Record<string, unknown>)?.default ?? exported) as unknown;
      if (typeof wiggleFn !== "function") throw new Error(`embedded wiggle for '${siteName}' must export a function`);
      return this.withPage(site, (page) => (wiggleFn as (page: Page) => Promise<string[]>)(page));
    }

    return ["no-wiggle-configured"];
  }

  async evalInPage(code: string, site?: string): Promise<unknown> {
    return this.withPage(site, (page) => page.evaluate(code));
  }

  async getUrl(site?: string): Promise<string> {
    return this.withPage(site, async (page) => page.url());
  }

  async getTitle(site?: string): Promise<string> {
    return this.withPage(site, async (page) => page.title());
  }

  async getHtml(site?: string): Promise<string> {
    return this.withPage(site, async (page) => page.content());
  }
}
