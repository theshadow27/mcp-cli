/**
 * Sniffer: consumes BrowserEvents, feeds the credential vault, and optionally
 * writes request/response artifacts to disk for later `mcx site calls` curation.
 *
 * Modes:
 *   off       — events are observed for credentials only; no disk writes. Lightweight
 *                request-metadata ring entries are still kept (URL/method/resourceType, no headers).
 *   filtered  — URLs matching the site's captureFilters.match (and not skip) are written to disk
 *                and kept in rings with full headers/body.
 *   firehose  — everything is kept, including WebSocket frames.
 *
 * A binary response's JSON carries a stub body. When the engine attached the bytes
 * (the site's opt-in `captureBinary`, see binary-capture.ts), they go to a sidecar
 * `<stem>.bin` next to `<stem>.json`, and the stub names it in `_file`.
 *
 * With the site's opt-in `captureHook` (see capture-hook.ts), each textual response
 * and each binary response that passed `captureBinary` goes through the hook first,
 * and its verdict decides what is written.
 *
 * This module is pure TypeScript — no Playwright imports.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserEvents, CapturedRequest, CapturedResponse, CapturedWsFrame } from "./browser/engine";
import {
  type CaptureHookFn,
  type CaptureHookSpec,
  type HookOutcome,
  HookRunner,
  type HookStats,
  createModuleLoader,
  resolveHookModule,
} from "./capture-hook";
import type { CaptureFilters } from "./config";
import type { CredentialVault } from "./credentials";
import { siteCapturesDir, sitePath } from "./paths";

export type CaptureMode = "off" | "filtered" | "firehose";

export interface RequestRecord {
  at: string;
  site: string;
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string | null;
}

export interface ResponseRecord {
  at: string;
  site: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  bytes: number;
  savedFile: string | null;
  /** Sidecar holding the decoded binary body, when one was written. */
  savedBinaryFile?: string | null;
  isText: boolean;
}

export interface WsFrameRecord {
  at: string;
  site: string;
  wsUrl: string;
  direction: "tx" | "rx";
  bytes: number;
  preview: string;
  savedFile: string | null;
}

const RING_SIZE = 500;
const WS_LIST_SIZE = 50;

function tsToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

function compileFilters(filters: CaptureFilters | undefined): { match: RegExp[]; skip: RegExp[] } {
  return {
    match: (filters?.match ?? []).map((p) => new RegExp(p, "i")),
    skip: (filters?.skip ?? []).map((p) => new RegExp(p, "i")),
  };
}

export class Sniffer {
  private modes = new Map<string, CaptureMode>();
  private filters = new Map<string, { match: RegExp[]; skip: RegExp[] }>();
  private reqRing: RequestRecord[] = [];
  private respRing: ResponseRecord[] = [];
  private wsFrameRing: WsFrameRecord[] = [];
  private wsList: Array<{ site: string; url: string; openedAt: string; frames: number }> = [];
  private hooks = new Map<string, HookRunner>();

  constructor(
    private vault: CredentialVault,
    /** Test seam: replaces the dynamic-import module loader. */
    private hookLoader: (modulePath: string) => () => Promise<CaptureHookFn> = createModuleLoader,
  ) {}

  configureSite(
    site: string,
    mode: CaptureMode,
    filters?: CaptureFilters,
    opts: { captureHook?: CaptureHookSpec } = {},
  ): void {
    this.modes.set(site, mode);
    this.filters.set(site, compileFilters(filters));
    const spec = opts.captureHook;
    if (spec) {
      const load = this.hookLoader(resolveHookModule(spec.module, sitePath(site)));
      const runner = new HookRunner(load, { timeoutMs: spec.timeoutMs, queueSize: spec.queueSize });
      runner.preload();
      this.hooks.set(site, runner);
    } else {
      this.hooks.delete(site);
    }
  }

  /** Counters for the site's capture hook, or null when it has none. */
  getHookStats(site: string): HookStats | null {
    return this.hooks.get(site)?.stats ?? null;
  }

  /** Resolves once every queued hook call has been written. */
  async drainHooks(): Promise<void> {
    await Promise.all([...this.hooks.values()].map((h) => h.drain()));
  }

  getMode(site: string): CaptureMode {
    return this.modes.get(site) ?? "off";
  }

  setMode(site: string, mode: CaptureMode): void {
    this.modes.set(site, mode);
  }

  asEvents(): BrowserEvents {
    return {
      onRequest: (site, req) => this.handleRequest(site, req),
      onResponse: (site, resp) => this.handleResponse(site, resp),
      onWsFrame: (site, frame) => this.handleWsFrame(site, frame),
      shouldCapture: (site, url) => this.shouldCapture(site, url),
    };
  }

  getRecentRequests(filter?: string): RequestRecord[] {
    return filterRing(this.reqRing, filter, (r) => [r.url]);
  }

  getRecentResponses(filter?: string): ResponseRecord[] {
    return filterRing(this.respRing, filter, (r) => [r.url]);
  }

  getRecentWsFrames(filter?: string): WsFrameRecord[] {
    return filterRing(this.wsFrameRing, filter, (f) => [f.wsUrl, f.preview]);
  }

  /** Whether handleResponse would write a capture for this URL. */
  shouldCapture(site: string, url: string): boolean {
    const mode = this.getMode(site);
    if (mode === "off") return false;
    return mode === "firehose" || this.passesFilter(site, url);
  }

  private passesFilter(site: string, url: string): boolean {
    // No filters configured yet (site never configureSite'd) — treat as match-all so
    // switching to `filtered` mode before start-up doesn't silently drop captures.
    const f = this.filters.get(site);
    if (!f) return true;
    if (f.skip.some((re) => re.test(url))) return false;
    if (f.match.length === 0) return true;
    return f.match.some((re) => re.test(url));
  }

  private handleRequest(site: string, req: CapturedRequest): void {
    try {
      this.vault.noteRequest(site, req);
    } catch {
      // Credential capture must not break observability.
    }

    const mode = this.getMode(site);
    if (mode === "off") {
      pushRing(this.reqRing, {
        at: tsToken(),
        site,
        method: req.method,
        url: req.url,
        resourceType: req.resourceType,
        headers: {},
        postData: null,
      });
      return;
    }
    if (mode === "filtered" && !this.passesFilter(site, req.url)) return;

    pushRing(this.reqRing, {
      at: tsToken(),
      site,
      method: req.method,
      url: req.url,
      resourceType: req.resourceType,
      headers: req.headers,
      postData: req.postData,
    });
  }

  private handleResponse(site: string, resp: CapturedResponse): void {
    const mode = this.getMode(site);
    if (mode === "off") return;
    if (mode === "filtered" && !this.passesFilter(site, resp.url)) return;

    const hook = this.hooks.get(site);
    // Binary responses without a body passed no captureBinary pre-filter: they skip the hook.
    const eligible = resp.bodyText !== null || resp.bodyBinary !== undefined || resp.bodyEvicted === true;
    if (!hook || !eligible) {
      this.writeResponse(site, resp, { kind: "keep", meta: undefined });
      return;
    }
    const input = {
      req: {
        url: resp.url,
        method: resp.method,
        headers: resp.requestHeaders,
        postData: resp.requestPostData,
        resourceType: resp.resourceType ?? "",
      },
      res: {
        url: resp.url,
        status: resp.status,
        headers: resp.headers,
        contentType: resp.contentType,
        bytes: resp.bodyBinary ?? null,
        bodyText: resp.bodyText,
      },
    };
    const queued = hook.submit(input, (outcome) => this.writeResponse(site, resp, outcome));
    if (!queued) this.writeResponse(site, resp, { kind: "stub", meta: { skipped: "queue-full" } });
  }

  private writeResponse(site: string, resp: CapturedResponse, outcome: HookOutcome): void {
    if (outcome.kind === "drop") return;
    const stubOnly = outcome.kind === "stub";
    const hookTag = outcome.kind === "fallback" ? outcome.hook : outcome.meta;

    const at = tsToken();
    const dir = siteCapturesDir(site);
    let savedFile: string | null = null;
    let savedBinaryFile: string | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      const stem = uniqueStem(dir, `${at}-${resp.method}-${shortHash(resp.url)}`);
      const file = join(dir, `${stem}.json`);
      let body: unknown;
      if (resp.bodyText !== null) {
        body = stubOnly
          ? { _omitted: true, _bytes: resp.bodyBytes, _contentType: resp.contentType }
          : tryParseJson(resp.bodyText, resp.contentType);
      } else {
        const stub: Record<string, unknown> = { _binary: true, _bytes: resp.bodyBytes, _contentType: resp.contentType };
        if (stubOnly) {
          // Seen, not kept: metadata only.
        } else if (resp.bodyBinary) {
          // Sidecar first, so a JSON that names a file never points at a missing one.
          try {
            const binFile = join(dir, `${stem}.bin`);
            writeFileSync(binFile, resp.bodyBinary);
            savedBinaryFile = binFile;
            stub._file = `${stem}.bin`;
          } catch {
            stub._file = null;
          }
        } else if (resp.bodyEvicted) {
          stub._file = null;
          stub._evicted = true;
        }
        body = stub;
      }
      const record: Record<string, unknown> = {
        _meta: {
          at,
          url: resp.url,
          method: resp.method,
          status: resp.status,
          contentType: resp.contentType,
          bytes: resp.bodyBytes,
        },
        ...(hookTag !== undefined ? { _hook: hookTag } : {}),
        requestHeaders: resp.requestHeaders,
        requestPostData: resp.requestPostData,
        responseHeaders: resp.headers,
        body,
      };
      writeFileSync(file, JSON.stringify(record, null, 2));
      savedFile = file;
    } catch {
      // Capture is best-effort.
    }

    pushRing(this.respRing, {
      at,
      site,
      url: resp.url,
      method: resp.method,
      status: resp.status,
      contentType: resp.contentType,
      bytes: resp.bodyBytes,
      savedFile,
      savedBinaryFile,
      isText: resp.bodyText !== null,
    });
  }

  private handleWsFrame(site: string, frame: CapturedWsFrame): void {
    const mode = this.getMode(site);
    if (mode === "off") return;

    const existing = this.wsList.find((w) => w.site === site && w.url === frame.wsUrl);
    if (!existing) {
      this.wsList.push({ site, url: frame.wsUrl, openedAt: tsToken(), frames: 1 });
      if (this.wsList.length > WS_LIST_SIZE) this.wsList.shift();
    } else {
      existing.frames++;
    }

    const at = tsToken();
    let savedFile: string | null = null;
    if (mode === "firehose") {
      try {
        const dir = siteCapturesDir(site);
        mkdirSync(dir, { recursive: true });
        savedFile = join(dir, `${at}-ws-${frame.direction}-${shortHash(frame.wsUrl)}.txt`);
        writeFileSync(savedFile, frame.payload);
      } catch {
        savedFile = null;
      }
    }

    pushRing(this.wsFrameRing, {
      at,
      site,
      wsUrl: frame.wsUrl,
      direction: frame.direction,
      bytes: frame.bytes,
      preview: frame.payload.slice(0, 400),
      savedFile,
    });
  }
}

/** Same URL within one millisecond would otherwise overwrite the earlier capture. */
function uniqueStem(dir: string, base: string): string {
  if (!existsSync(join(dir, `${base}.json`))) return base;
  for (let n = 1; ; n++) {
    const stem = `${base}-${n}`;
    if (!existsSync(join(dir, `${stem}.json`))) return stem;
  }
}

function pushRing<T>(ring: T[], item: T): void {
  ring.push(item);
  if (ring.length > RING_SIZE) ring.shift();
}

function filterRing<T>(ring: T[], filter: string | undefined, fields: (entry: T) => string[]): T[] {
  if (!filter) return [...ring];
  let re: RegExp;
  try {
    re = new RegExp(filter, "i");
  } catch {
    // Invalid regex from user input — fall back to substring match (case-insensitive).
    const needle = filter.toLowerCase();
    return ring.filter((entry) => fields(entry).some((f) => f.toLowerCase().includes(needle)));
  }
  return ring.filter((entry) => fields(entry).some((f) => re.test(f)));
}

function tryParseJson(text: string, contentType: string): unknown {
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { _unparsedJson: text.slice(0, 200_000) };
    }
  }
  return { _text: text.slice(0, 200_000) };
}
