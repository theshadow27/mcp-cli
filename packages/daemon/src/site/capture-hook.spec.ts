import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import type { CapturedResponse } from "./browser/engine";
import {
  type CaptureHookFn,
  HookRunner,
  createModuleLoader,
  resolveHookModule,
  validateCaptureHook,
} from "./capture-hook";
import { CredentialVault } from "./credentials";
import { Sniffer } from "./sniffer";

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), `mcp-cli-hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  options.SITES_DIR = join(tmp, "sites");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _restoreOptions();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const imageResp = (extra: Partial<CapturedResponse> = {}): CapturedResponse => ({
  url: "https://cdn.example/a.jpg",
  method: "GET",
  status: 200,
  contentType: "image/jpeg",
  headers: { "content-type": "image/jpeg" },
  bodyBytes: 3,
  bodyText: null,
  requestHeaders: { accept: "image/*" },
  requestPostData: null,
  resourceType: "image",
  bodyBinary: new Uint8Array([1, 2, 3]),
  ...extra,
});

function sniffWith(
  hook: CaptureHookFn,
  spec: { timeoutMs?: number; queueSize?: number } = {},
): {
  sniffer: Sniffer;
  send: (r: CapturedResponse) => void;
  files: () => string[];
  json: () => Record<string, unknown>[];
} {
  const sniffer = new Sniffer(new CredentialVault(), () => async () => hook);
  sniffer.configureSite("s", "firehose", undefined, { captureHook: { module: "hook.js", ...spec } });
  const dir = join(options.SITES_DIR, "s", "captures");
  const files = () => (existsSync(dir) ? readdirSync(dir).sort() : []);
  return {
    sniffer,
    send: (r) => sniffer.asEvents().onResponse?.("s", r),
    files,
    json: () =>
      files()
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8"))),
  };
}

describe("validateCaptureHook", () => {
  test("string shorthand and full object", () => {
    expect(validateCaptureHook("h.js")).toEqual({ module: "h.js" });
    expect(validateCaptureHook({ module: "h.js", timeoutMs: 10, queueSize: 2 })).toEqual({
      module: "h.js",
      timeoutMs: 10,
      queueSize: 2,
    });
  });

  test("rejects bad shapes", () => {
    expect(() => validateCaptureHook({})).toThrow(/module must be a path/);
    expect(() => validateCaptureHook({ module: "h.js", timeoutMs: 0 })).toThrow(/positive integer/);
    expect(() => validateCaptureHook({ module: "h.js", x: 1 })).toThrow(/unknown key 'x'/);
    expect(() => validateCaptureHook(7)).toThrow(/module path/);
  });

  test("resolveHookModule: relative paths resolve against the site dir", () => {
    expect(resolveHookModule("h.js", "/sites/s")).toBe("/sites/s/h.js");
    expect(resolveHookModule("/abs/h.js", "/sites/s")).toBe("/abs/h.js");
  });
});

describe("createModuleLoader", () => {
  const counterHook = `let n = 0;
export default async () => {
  n++;
  return { keep: false, meta: { n } };
};
`;
  const call = async (load: () => Promise<CaptureHookFn>) =>
    (await load())({} as never) as Promise<{ meta: { n: number } }>;

  test("loads once and keeps module-level state across calls", async () => {
    const path = join(tmp, "counter.ts");
    writeFileSync(path, counterHook);
    const load = createModuleLoader(path);
    expect((await call(load)).meta.n).toBe(1);
    expect((await call(load)).meta.n).toBe(2);
    expect(await load()).toBe(await load());
  });

  test("a second loader for an unchanged source reuses the resident instance", async () => {
    const path = join(tmp, "shared.ts");
    writeFileSync(path, counterHook);
    expect((await call(createModuleLoader(path))).meta.n).toBe(1);
    expect((await call(createModuleLoader(path))).meta.n).toBe(2);
  });

  test("a changed source loads fresh on the next loader, never per call", async () => {
    const path = join(tmp, "changing.ts");
    writeFileSync(path, counterHook);
    const first = createModuleLoader(path);
    expect((await call(first)).meta.n).toBe(1);
    writeFileSync(path, counterHook.replace("n++", "n += 10"));
    expect((await call(first)).meta.n).toBe(2);
    expect((await call(createModuleLoader(path))).meta.n).toBe(10);
  });

  test("a module without a default function throws", async () => {
    const path = join(tmp, "bad.ts");
    writeFileSync(path, "export const x = 1;");
    await expect(createModuleLoader(path)()).rejects.toThrow(/no default export/);
  });
});

describe("Sniffer with captureHook", () => {
  test("hook receives req and res with the decoded bytes", async () => {
    let seen: Parameters<CaptureHookFn>[0] | null = null;
    const { sniffer, send } = sniffWith(async (input) => {
      seen = input;
      return false;
    });
    send(imageResp());
    await sniffer.drainHooks();
    expect(seen).not.toBeNull();
    const got = seen as unknown as Parameters<CaptureHookFn>[0];
    expect(got.req).toEqual({
      url: "https://cdn.example/a.jpg",
      method: "GET",
      headers: { accept: "image/*" },
      postData: null,
      resourceType: "image",
    });
    expect([...(got.res.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(got.res.bodyText).toBeNull();
  });

  test("false writes nothing", async () => {
    const { sniffer, send, files } = sniffWith(async () => false);
    send(imageResp());
    await sniffer.drainHooks();
    expect(files()).toEqual([]);
    expect(sniffer.getRecentResponses()).toHaveLength(0);
    expect(sniffer.getHookStats("s")?.dropped).toBe(1);
  });

  test("keep:true writes JSON with _hook and the sidecar", async () => {
    const { sniffer, send, files, json } = sniffWith(async () => ({ keep: true, meta: { label: "x" } }));
    send(imageResp());
    await sniffer.drainHooks();
    expect(files().filter((f) => f.endsWith(".bin"))).toHaveLength(1);
    const [rec] = json();
    expect(rec._hook).toEqual({ label: "x" });
    expect((rec.body as Record<string, unknown>)._file).toMatch(/\.bin$/);
  });

  test("keep:false (and keep omitted) writes a stub JSON with _hook and no sidecar", async () => {
    const { sniffer, send, files, json } = sniffWith(async () => ({ meta: { score: 0.1 } }));
    send(imageResp());
    send(imageResp({ bodyBinary: undefined, bodyText: '{"a":1}', contentType: "application/json" }));
    await sniffer.drainHooks();
    for (const f of files()) expect(f.endsWith(".bin")).toBe(false);
    const recs = json();
    expect(recs.map((r) => r._hook)).toEqual([{ score: 0.1 }, { score: 0.1 }]);
    const bodies = recs.map((r) => r.body as Record<string, unknown>);
    expect(bodies.find((b) => b._binary)).toEqual({ _binary: true, _bytes: 3, _contentType: "image/jpeg" });
    expect(bodies.find((b) => b._omitted)).toEqual({ _omitted: true, _bytes: 3, _contentType: "application/json" });
    expect(sniffer.getHookStats("s")?.stubbed).toBe(2);
  });

  test("a throwing hook falls back to the unhooked capture and counts the error", async () => {
    const { sniffer, send, files, json } = sniffWith(async () => {
      throw new Error("boom");
    });
    send(imageResp());
    await sniffer.drainHooks();
    expect(files().filter((f) => f.endsWith(".bin"))).toHaveLength(1);
    expect(json()[0]._hook).toEqual({ error: "threw" });
    expect(sniffer.getHookStats("s")).toMatchObject({ errors: 1, lastError: "boom" });
  });

  test("an invalid return value falls back and counts the error", async () => {
    const { sniffer, send, json } = sniffWith(async () => "yes");
    send(imageResp());
    await sniffer.drainHooks();
    expect(json()[0]._hook).toEqual({ error: "invalid-return" });
    expect(sniffer.getHookStats("s")?.errors).toBe(1);
  });

  test("a hook past timeoutMs falls back and counts the timeout", async () => {
    const { sniffer, send, files, json } = sniffWith(() => new Promise(() => {}), { timeoutMs: 1 });
    send(imageResp());
    await sniffer.drainHooks();
    expect(files().filter((f) => f.endsWith(".bin"))).toHaveLength(1);
    expect(json()[0]._hook).toEqual({ error: "timeout" });
    expect(sniffer.getHookStats("s")?.timeouts).toBe(1);
  });

  test("a full queue records a stub with _hook.skipped and counts it", async () => {
    const gate = deferred();
    const { sniffer, send, files, json } = sniffWith(
      async () => {
        await gate.promise;
        return { keep: true };
      },
      { queueSize: 1 },
    );
    send(imageResp({ url: "https://cdn.example/1.jpg" }));
    send(imageResp({ url: "https://cdn.example/2.jpg" }));
    // The second response is written synchronously as a stub; the first is still waiting on the hook.
    const early = json();
    expect(early).toHaveLength(1);
    expect(early[0]._hook).toEqual({ skipped: "queue-full" });
    for (const f of files()) expect(f.endsWith(".bin")).toBe(false);
    gate.resolve();
    await sniffer.drainHooks();
    expect(files().filter((f) => f.endsWith(".bin"))).toHaveLength(1);
    expect(sniffer.getHookStats("s")).toMatchObject({ queueFull: 1, kept: 1 });
  });

  test("binary responses outside captureBinary skip the hook", async () => {
    let calls = 0;
    const { sniffer, send, json } = sniffWith(async () => {
      calls++;
      return false;
    });
    send(imageResp({ bodyBinary: undefined }));
    await sniffer.drainHooks();
    expect(calls).toBe(0);
    expect(json()).toHaveLength(1);
    expect(json()[0]._hook).toBeUndefined();
  });

  test("evicted bodies reach the hook with bytes null", async () => {
    let bytes: Uint8Array | null | undefined;
    const { sniffer, send, json } = sniffWith(async ({ res }) => {
      bytes = res.bytes;
      return { keep: true };
    });
    send(imageResp({ bodyBinary: undefined, bodyEvicted: true }));
    await sniffer.drainHooks();
    expect(bytes).toBeNull();
    expect((json()[0].body as Record<string, unknown>)._evicted).toBe(true);
  });
});

describe("HookRunner", () => {
  test("runs calls one at a time in order", async () => {
    const order: number[] = [];
    let inFlight = 0;
    let max = 0;
    const runner = new HookRunner(async () => async ({ req }) => {
      inFlight++;
      max = Math.max(max, inFlight);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      inFlight--;
      order.push(Number(req.url));
      return false;
    });
    const input = (n: number) => ({
      req: { url: String(n), method: "GET", headers: {}, postData: null, resourceType: "" },
      res: { url: String(n), status: 200, headers: {}, contentType: "", bytes: null, bodyText: null },
    });
    for (const n of [1, 2, 3]) runner.submit(input(n), () => {});
    await runner.drain();
    expect(order).toEqual([1, 2, 3]);
    expect(max).toBe(1);
  });
});
