import { describe, expect, test } from "bun:test";
import {
  BinaryBodyTap,
  type CdpSessionLike,
  isRedirectStatus,
  sizeMatches,
  typeMatches,
  validateCaptureBinary,
} from "./binary-capture";
import type { BrowserEvents, CaptureBinarySpec, CapturedResponse } from "./browser/engine";

type Handler = (p: unknown) => void;

function fakeCdp(bodies: Record<string, { body: string; base64Encoded: boolean } | Error>): CdpSessionLike & {
  fire(event: string, params: unknown): void;
  sent: Array<{ method: string; params?: Record<string, unknown> }>;
} {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    sent,
    async send(method, params) {
      sent.push({ method, params });
      if (method !== "Network.getResponseBody") return {};
      const r = bodies[params?.requestId as string];
      if (!r) throw new Error("No data found for resource with given identifier");
      if (r instanceof Error) throw r;
      return r;
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    fire(event, params) {
      for (const h of handlers.get(event) ?? []) h(params);
    },
  };
}

const SPEC: CaptureBinarySpec = { types: ["image/jpeg", "image/webp"], minBytes: 10, maxBytes: 1000 };

function load(
  cdp: ReturnType<typeof fakeCdp>,
  id: string,
  opts: { url?: string; contentType?: string; status?: number; bytes?: number; finish?: "ok" | "fail" } = {},
): void {
  cdp.fire("Network.requestWillBeSent", {
    requestId: id,
    request: { method: "GET", headers: { Accept: "image/*" } },
  });
  cdp.fire("Network.responseReceived", {
    requestId: id,
    response: {
      url: opts.url ?? `https://cdn.example/${id}.jpg`,
      status: opts.status ?? 200,
      mimeType: "image/jpeg",
      headers: { "Content-Type": opts.contentType ?? "image/jpeg" },
    },
  });
  cdp.fire("Network.dataReceived", { requestId: id, dataLength: opts.bytes ?? 100 });
  cdp.fire(opts.finish === "fail" ? "Network.loadingFailed" : "Network.loadingFinished", { requestId: id });
}

async function tapWith(
  bodies: Parameters<typeof fakeCdp>[0],
  events: Partial<BrowserEvents> = {},
  spec: CaptureBinarySpec = SPEC,
): Promise<{ cdp: ReturnType<typeof fakeCdp>; tap: BinaryBodyTap; got: CapturedResponse[] }> {
  const got: CapturedResponse[] = [];
  const cdp = fakeCdp(bodies);
  const tap = new BinaryBodyTap("site", spec, { onResponse: (_s, r) => got.push(r), ...events });
  await tap.attach(cdp);
  return { cdp, tap, got };
}

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");

describe("validateCaptureBinary", () => {
  test("accepts a full spec and lowercases types", () => {
    expect(validateCaptureBinary({ types: ["Image/JPEG"], minBytes: 1, maxBytes: 2 })).toEqual({
      types: ["image/jpeg"],
      minBytes: 1,
      maxBytes: 2,
    });
  });

  test("rejects bad shapes", () => {
    expect(() => validateCaptureBinary(null)).toThrow(/must be an object/);
    expect(() => validateCaptureBinary({ types: [] })).toThrow(/non-empty array/);
    expect(() => validateCaptureBinary({ types: ["image/png"], minBytes: -1 })).toThrow(/non-negative/);
    expect(() => validateCaptureBinary({ types: ["image/png"], minBytes: 5, maxBytes: 4 })).toThrow(/exceed/);
    expect(() => validateCaptureBinary({ types: ["image/png"], extra: 1 })).toThrow(/unknown key 'extra'/);
  });
});

describe("matching", () => {
  test("typeMatches drops parameters and honours type/*", () => {
    expect(typeMatches(SPEC, "image/JPEG; charset=binary")).toBe(true);
    expect(typeMatches(SPEC, "image/png")).toBe(false);
    expect(typeMatches({ types: ["image/*"] }, "image/png")).toBe(true);
    expect(typeMatches({ types: ["image/*"] }, "video/mp4")).toBe(false);
    expect(typeMatches(SPEC, "")).toBe(false);
  });

  test("sizeMatches is inclusive and defaults maxBytes to 20 MB", () => {
    expect(sizeMatches(SPEC, 10)).toBe(true);
    expect(sizeMatches(SPEC, 1000)).toBe(true);
    expect(sizeMatches(SPEC, 9)).toBe(false);
    expect(sizeMatches(SPEC, 1001)).toBe(false);
    expect(sizeMatches({ types: ["x/y"] }, 20_000_000)).toBe(true);
    expect(sizeMatches({ types: ["x/y"] }, 20_000_001)).toBe(false);
  });

  test("isRedirectStatus covers 3xx only", () => {
    expect(isRedirectStatus(302)).toBe(true);
    expect(isRedirectStatus(200)).toBe(false);
    expect(isRedirectStatus(400)).toBe(false);
  });
});

describe("BinaryBodyTap", () => {
  test("enables Network with buffer sizes derived from maxBytes", async () => {
    const { cdp } = await tapWith({});
    expect(cdp.sent[0]).toEqual({
      method: "Network.enable",
      params: { maxResourceBufferSize: 1000, maxTotalBufferSize: 100_000_000 },
    });
  });

  test("decodes a base64 body for a matching response", async () => {
    const { cdp, tap, got } = await tapWith(
      { r1: { body: b64([1, 2, 3, 255]), base64Encoded: true } },
      {},
      { types: ["image/jpeg"] },
    );
    load(cdp, "r1", { bytes: 4 });
    await tap.drain();
    expect(got).toHaveLength(1);
    expect([...(got[0].bodyBinary ?? [])]).toEqual([1, 2, 3, 255]);
    expect(got[0].bodyBytes).toBe(4);
    expect(got[0].bodyText).toBeNull();
    expect(got[0].contentType).toBe("image/jpeg");
    expect(got[0].requestHeaders).toEqual({ Accept: "image/*" });
  });

  test("accepts a non-base64 body", async () => {
    const { cdp, tap, got } = await tapWith(
      { r1: { body: "abcdefghijkl", base64Encoded: false } },
      {},
      { types: ["image/jpeg"] },
    );
    load(cdp, "r1", { bytes: 12 });
    await tap.drain();
    expect(Buffer.from(got[0].bodyBinary ?? []).toString()).toBe("abcdefghijkl");
  });

  test("a body the browser no longer holds is marked evicted, never re-fetched", async () => {
    const { cdp, tap, got } = await tapWith({});
    load(cdp, "gone", { bytes: 50 });
    await tap.drain();
    expect(got[0].bodyEvicted).toBe(true);
    expect(got[0].bodyBinary).toBeUndefined();
    expect(cdp.sent.map((s) => s.method)).toEqual(["Network.enable", "Network.getResponseBody"]);
  });

  test("an empty body for a non-empty response is evicted", async () => {
    const { cdp, tap, got } = await tapWith({ r1: { body: "", base64Encoded: true } });
    load(cdp, "r1", { bytes: 50 });
    await tap.drain();
    expect(got[0].bodyEvicted).toBe(true);
  });

  test("outside the size window: metadata only, no body read", async () => {
    const { cdp, tap, got } = await tapWith({});
    load(cdp, "small", { bytes: 5 });
    load(cdp, "big", { bytes: 5000 });
    await tap.drain();
    expect(got.map((r) => [r.bodyBytes, r.bodyBinary, r.bodyEvicted])).toEqual([
      [5, undefined, undefined],
      [5000, undefined, undefined],
    ]);
    expect(cdp.sent.some((s) => s.method === "Network.getResponseBody")).toBe(false);
  });

  test("non-matching binary type: metadata only, no body read", async () => {
    const { cdp, tap, got } = await tapWith({});
    load(cdp, "p", { contentType: "image/png" });
    await tap.drain();
    expect(got).toHaveLength(1);
    expect(got[0].bodyBinary).toBeUndefined();
    expect(cdp.sent.some((s) => s.method === "Network.getResponseBody")).toBe(false);
  });

  test("decoded size above maxBytes is not attached", async () => {
    const { cdp, tap, got } = await tapWith({ r1: { body: b64(new Array(2000).fill(7)), base64Encoded: true } });
    load(cdp, "r1", { bytes: 100 });
    await tap.drain();
    expect(got[0].bodyBinary).toBeUndefined();
    expect(got[0].bodyBytes).toBe(2000);
  });

  test("shouldCapture=false skips the body read", async () => {
    const { cdp, tap, got } = await tapWith(
      { r1: { body: b64([1]), base64Encoded: true } },
      { shouldCapture: () => false },
    );
    load(cdp, "r1");
    await tap.drain();
    expect(got[0].bodyBinary).toBeUndefined();
    expect(cdp.sent.some((s) => s.method === "Network.getResponseBody")).toBe(false);
  });

  test("textual and 3xx responses are left to the Playwright path", async () => {
    const { cdp, tap, got } = await tapWith({});
    load(cdp, "t", { contentType: "application/json" });
    load(cdp, "r", { status: 304 });
    await tap.drain();
    expect(got).toHaveLength(0);
  });

  test("a failed load emits a metadata stub", async () => {
    const { cdp, tap, got } = await tapWith({});
    load(cdp, "f", { bytes: 30, finish: "fail" });
    await tap.drain();
    expect(got).toHaveLength(1);
    expect(got[0].bodyBytes).toBe(30);
    expect(got[0].bodyBinary).toBeUndefined();
  });

  test("body reads run one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const got: CapturedResponse[] = [];
    const handlers = new Map<string, Handler[]>();
    const cdp: CdpSessionLike = {
      async send(method) {
        if (method !== "Network.getResponseBody") return {};
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        for (let i = 0; i < 5; i++) await Promise.resolve(); // yield so unserialized reads would overlap
        inFlight--;
        return { body: b64(new Array(100).fill(1)), base64Encoded: true };
      },
      on(event, h) {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
    };
    const tap = new BinaryBodyTap("site", SPEC, { onResponse: (_s, r) => got.push(r) });
    await tap.attach(cdp);
    const fire = (e: string, p: unknown) => {
      for (const h of handlers.get(e) ?? []) h(p);
    };
    for (const id of ["a", "b", "c"]) {
      fire("Network.requestWillBeSent", { requestId: id, request: { method: "GET" } });
      fire("Network.responseReceived", {
        requestId: id,
        response: { url: `u/${id}`, status: 200, headers: { "content-type": "image/webp" } },
      });
      fire("Network.dataReceived", { requestId: id, dataLength: 100 });
      fire("Network.loadingFinished", { requestId: id });
    }
    await tap.drain();
    expect(got.map((r) => r.url)).toEqual(["u/a", "u/b", "u/c"]);
    expect(maxInFlight).toBe(1);
  });
});
