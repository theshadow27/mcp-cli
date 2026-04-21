/**
 * BrowserEngine abstraction — decouples site-worker tool handlers from the
 * concrete browser driver (Playwright today, Bun.WebView planned).
 *
 * Types here must be plain JS / JSON-shaped so adapters can be plugged in
 * without leaking Playwright's type surface. Heavy deps (playwright) live
 * only inside adapter implementations loaded via dynamic import.
 */

export interface SiteSpec {
  name: string;
  url: string;
  blockProtocols?: string[];
  /** Absolute path to a wiggle.js module (exports default `async (page) => string[]`). Optional. */
  wigglePath?: string;
  /** Profile dir the adapter should use for this site's user data. */
  profileDir: string;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
}

export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  bodyBytes: number;
  /** When the content-type is textual, body is a string. Otherwise null (only metadata is captured). */
  bodyText: string | null;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
}

export interface CapturedWsFrame {
  wsUrl: string;
  direction: "tx" | "rx";
  bytes: number;
  payload: string;
}

export interface BrowserEvents {
  onRequest?: (site: string, req: CapturedRequest) => void;
  onResponse?: (site: string, resp: CapturedResponse) => void;
  onWsFrame?: (site: string, frame: CapturedWsFrame) => void;
}

export interface ColdStartResult {
  cleared: string[];
  reloaded: boolean;
}

export interface StartSiteResult {
  site: string;
  url: string;
  status: "navigated" | "failed" | "already-running";
  error?: string;
}

export interface BrowserEngine {
  /**
   * Idempotent; if already running, returns each pinned site with status `already-running`.
   * `events` is wired for the lifetime.
   */
  start(sites: SiteSpec[], events: BrowserEvents): Promise<StartSiteResult[]>;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** Names of sites currently pinned to a tab/window. */
  getSiteNames(): string[];
  /** Clear non-cookie storage for the site's origin and reload. */
  coldStart(site?: string): Promise<ColdStartResult>;
  /** Run the site's wiggle module in the page context; returns whatever the script returns. */
  wiggle(site?: string): Promise<string[]>;
  /** Evaluate an expression in the page's JS context. Results must be JSON-serializable. */
  evalInPage(code: string, site?: string): Promise<unknown>;
  getUrl(site?: string): Promise<string>;
  getTitle(site?: string): Promise<string>;
  getHtml(site?: string): Promise<string>;
}

/** The single concrete engine name users configure in site.config.browser.engine. */
export type BrowserEngineName = "playwright" | "webview";

export class BrowserEngineUnavailable extends Error {
  constructor(engine: BrowserEngineName, detail: string) {
    super(`Browser engine '${engine}' is unavailable: ${detail}`);
    this.name = "BrowserEngineUnavailable";
  }
}
