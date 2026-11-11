/**
 * Opt-in capture of binary response bodies (`captureBinary` in a site's config.json).
 *
 * The browser already holds every response body it loaded. When a site opts in,
 * `BinaryBodyTap` listens on a dedicated CDP session and reads matching bodies
 * out of the browser's own buffer with `Network.getResponseBody`. It never issues
 * a network request: a body the browser no longer holds is reported as evicted,
 * never re-fetched. (Playwright's `Response.body()` falls back to
 * `Network.loadNetworkResource` for an evicted body, which can re-fetch; that is
 * why opted-in sites route non-textual responses through this tap instead.)
 *
 * This module is pure TypeScript — no Playwright imports. The CDP session is
 * injected as `CdpSessionLike`, so tests drive it with a fake.
 */

import type { BrowserEvents, CaptureBinarySpec, CapturedResponse } from "./browser/engine";

export type { CaptureBinarySpec };

export const DEFAULT_CAPTURE_BINARY_MAX_BYTES = 20_000_000;

/** Validate a raw `captureBinary` value. Throws with a user-facing message on a bad shape. */
export function validateCaptureBinary(raw: unknown): CaptureBinarySpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('captureBinary must be an object like {"types":["image/jpeg"]}');
  }
  const r = raw as Record<string, unknown>;
  const known = new Set(["types", "minBytes", "maxBytes"]);
  for (const k of Object.keys(r)) {
    if (!known.has(k)) throw new Error(`captureBinary: unknown key '${k}' (allowed: types, minBytes, maxBytes)`);
  }
  if (!Array.isArray(r.types) || r.types.length === 0 || !r.types.every((t) => typeof t === "string" && t.length > 0)) {
    throw new Error("captureBinary.types must be a non-empty array of media types");
  }
  const out: CaptureBinarySpec = { types: r.types.map((t) => (t as string).toLowerCase()) };
  for (const k of ["minBytes", "maxBytes"] as const) {
    const v = r[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`captureBinary.${k} must be a non-negative integer`);
    }
    out[k] = v;
  }
  if (out.minBytes !== undefined && out.maxBytes !== undefined && out.minBytes > out.maxBytes) {
    throw new Error("captureBinary.minBytes must not exceed maxBytes");
  }
  return out;
}

/** The media type of a Content-Type value: lowercased, parameters dropped. */
export function mediaType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

export function typeMatches(spec: CaptureBinarySpec, contentType: string): boolean {
  const mt = mediaType(contentType);
  if (!mt) return false;
  return spec.types.some((t) => t === mt || (t.endsWith("/*") && mt.startsWith(t.slice(0, -1))));
}

export function sizeMatches(spec: CaptureBinarySpec, bytes: number): boolean {
  const max = spec.maxBytes ?? DEFAULT_CAPTURE_BINARY_MAX_BYTES;
  return bytes >= (spec.minBytes ?? 0) && bytes <= max;
}

/** 3xx responses: the Playwright path keeps reporting them as before. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

const MAX_TRACKED_REQUESTS = 5000;

/** Content types whose bodies the sniffer records as text. Everything else is binary. */
export function isTextual(contentType: string): boolean {
  if (!contentType) return true;
  return (
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("form")
  );
}

/** The subset of a CDP session the tap needs. Playwright's CDPSession satisfies it. */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): unknown;
}

interface Pending {
  url: string;
  method: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
  resourceType: string;
  bytes: number;
}

interface RequestInfo {
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string | null;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Reads non-textual response bodies from one page's CDP session and forwards
 * them to `events.onResponse`. Every non-textual, non-redirect response is
 * forwarded (so metadata stubs are still written); a body is attached only when
 * the response matches `spec` and `events.shouldCapture` accepts its URL.
 *
 * Body reads run one at a time, so the daemon holds at most one body (plus its
 * base64 form) in memory per page. Size is checked against the decoded byte
 * count from `Network.dataReceived` before the read, so an oversized body is
 * never transferred.
 */
export class BinaryBodyTap {
  private requests = new Map<string, RequestInfo>();
  private pending = new Map<string, Pending>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private site: string,
    private spec: CaptureBinarySpec,
    private events: BrowserEvents,
  ) {}

  /** Subscribe to the session's Network events and enable the domain. */
  async attach(cdp: CdpSessionLike): Promise<void> {
    cdp.on("Network.requestWillBeSent", (p) => this.onRequestWillBeSent(p as never));
    cdp.on("Network.responseReceived", (p) => this.onResponseReceived(p as never));
    cdp.on("Network.dataReceived", (p) => this.onDataReceived(p as never));
    cdp.on("Network.loadingFinished", (p) => this.onLoadingFinished(cdp, p as never));
    cdp.on("Network.loadingFailed", (p) => this.onLoadingFailed(p as never));
    const max = this.spec.maxBytes ?? DEFAULT_CAPTURE_BINARY_MAX_BYTES;
    await cdp.send("Network.enable", {
      maxResourceBufferSize: max,
      maxTotalBufferSize: Math.max(100_000_000, max * 2),
    });
  }

  /** Resolves once every queued body read has finished. */
  drain(): Promise<void> {
    return this.queue;
  }

  onRequestWillBeSent(p: {
    requestId: string;
    request: { method: string; headers?: Record<string, string>; postData?: string };
    type?: string;
  }): void {
    // Requests answered without a Network.loading* event (e.g. memory-cache hits) never leave the map.
    if (this.requests.size >= MAX_TRACKED_REQUESTS) this.requests.clear();
    this.requests.set(p.requestId, {
      method: p.request.method,
      resourceType: (p.type ?? "").toLowerCase(),
      headers: p.request.headers ?? {},
      postData: p.request.postData ?? null,
    });
  }

  onResponseReceived(p: {
    requestId: string;
    response: { url: string; status: number; mimeType?: string; headers?: Record<string, string> };
  }): void {
    const headers = p.response.headers ?? {};
    const contentType = headerValue(headers, "content-type") ?? p.response.mimeType ?? "";
    if (isTextual(contentType) || isRedirectStatus(p.response.status)) {
      // Textual and 3xx responses stay on the Playwright path.
      this.requests.delete(p.requestId);
      return;
    }
    const req = this.requests.get(p.requestId);
    this.pending.set(p.requestId, {
      url: p.response.url,
      method: req?.method ?? "GET",
      status: p.response.status,
      contentType,
      headers,
      requestHeaders: req?.headers ?? {},
      requestPostData: req?.postData ?? null,
      resourceType: req?.resourceType ?? "",
      bytes: 0,
    });
  }

  onDataReceived(p: { requestId: string; dataLength: number }): void {
    const entry = this.pending.get(p.requestId);
    if (entry) entry.bytes += p.dataLength;
  }

  onLoadingFailed(p: { requestId: string }): void {
    const entry = this.take(p.requestId);
    if (entry) this.emit(entry, {});
  }

  onLoadingFinished(cdp: CdpSessionLike, p: { requestId: string }): void {
    const entry = this.take(p.requestId);
    if (!entry) return;
    const wanted =
      typeMatches(this.spec, entry.contentType) &&
      sizeMatches(this.spec, entry.bytes) &&
      (this.events.shouldCapture?.(this.site, entry.url) ?? true);
    if (!wanted) {
      this.emit(entry, {});
      return;
    }
    this.queue = this.queue.then(() => this.readBody(cdp, p.requestId, entry));
  }

  private take(requestId: string): Pending | undefined {
    const entry = this.pending.get(requestId);
    this.pending.delete(requestId);
    this.requests.delete(requestId);
    return entry;
  }

  private async readBody(cdp: CdpSessionLike, requestId: string, entry: Pending): Promise<void> {
    let body: Uint8Array | null = null;
    try {
      const res = (await cdp.send("Network.getResponseBody", { requestId })) as {
        body?: string;
        base64Encoded?: boolean;
      };
      const raw = res?.body ?? "";
      const buf = Buffer.from(raw, res?.base64Encoded ? "base64" : "utf-8");
      if (buf.length > 0 || entry.bytes === 0) body = buf;
    } catch {
      // "No data found for resource with given identifier" — evicted from the browser's buffer.
    }
    if (body === null) {
      this.emit(entry, { bodyEvicted: true });
      return;
    }
    if (!sizeMatches(this.spec, body.length)) {
      // Decoded size disagreed with the dataReceived count; honour the configured limits.
      this.emit(entry, { bodyBytes: body.length });
      return;
    }
    this.emit(entry, { bodyBinary: body, bodyBytes: body.length });
  }

  private emit(entry: Pending, extra: Partial<CapturedResponse>): void {
    const resp: CapturedResponse = {
      url: entry.url,
      method: entry.method,
      status: entry.status,
      contentType: entry.contentType,
      headers: entry.headers,
      bodyBytes: entry.bytes,
      bodyText: null,
      requestHeaders: entry.requestHeaders,
      requestPostData: entry.requestPostData,
      resourceType: entry.resourceType,
      ...extra,
    };
    try {
      this.events.onResponse?.(this.site, resp);
    } catch {
      // Never propagate capture errors.
    }
  }
}
