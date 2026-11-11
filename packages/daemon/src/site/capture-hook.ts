/**
 * Opt-in per-site capture hook (`captureHook` in a site's config.json).
 *
 * A local JS module whose default export decides, per response, what the sniffer
 * writes. It runs in the daemon after the body is in hand and before anything is
 * written:
 *
 *   export default async ({ req, res }) => false | { keep?: boolean, meta?: object }
 *
 *   false               — write nothing for this response.
 *   { keep: true, meta } — write the capture as usual (binary body to the `.bin` sidecar), plus `_hook: meta`.
 *   { keep: false, meta } (or keep omitted) — write a stub JSON with `_hook: meta` and no body or sidecar.
 *
 * Calls run on a bounded queue, one at a time, so the browser event path never
 * waits on the hook. A full queue, a throw, a timeout or an invalid return never
 * loses the response: it is written as it would be without a hook, with `_hook`
 * naming why, and counted in `HookStats`.
 *
 * The module is loaded once and kept resident: module-level state persists across
 * calls. It is re-loaded only when the site is configured again (browser start)
 * and its source has changed.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { bundleAlias, computeSourceHash, evalBundledDefaultExport } from "@mcp-cli/core";

export interface CaptureHookSpec {
  /** Path to the module: absolute, `~/…`, or relative to the site directory. */
  module: string;
  /** Per-call timeout. Default 5000 ms. */
  timeoutMs?: number;
  /** Responses that may wait for the hook. Default 16. Each holds its body in memory. */
  queueSize?: number;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 5000;
export const DEFAULT_HOOK_QUEUE_SIZE = 16;

export interface CaptureHookRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
}

export interface CaptureHookResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  /** Decoded binary body, or null for a textual or evicted body. */
  bytes: Uint8Array | null;
  bodyText: string | null;
}

export type CaptureHookVerdict = false | { keep?: boolean; meta?: Record<string, unknown> };
export type CaptureHookFn = (input: { req: CaptureHookRequest; res: CaptureHookResponse }) => unknown;

/** What the sniffer does with one response once the hook has answered. */
export type HookOutcome =
  | { kind: "drop" }
  | { kind: "keep"; meta: unknown }
  | { kind: "stub"; meta: unknown }
  /** Hook unavailable for this response: write as without a hook, tagged with `_hook`. */
  | { kind: "fallback"; hook: Record<string, unknown> };

export interface HookStats {
  calls: number;
  kept: number;
  stubbed: number;
  dropped: number;
  errors: number;
  timeouts: number;
  queueFull: number;
  lastError: string | null;
}

/** Validate a raw `captureHook` value. A string is shorthand for `{ module }`. */
export function validateCaptureHook(raw: unknown): CaptureHookSpec {
  const r = typeof raw === "string" ? { module: raw } : raw;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    throw new Error('captureHook must be a module path or {"module":"<path>","timeoutMs":5000,"queueSize":16}');
  }
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["module", "timeoutMs", "queueSize"].includes(k)) {
      throw new Error(`captureHook: unknown key '${k}' (allowed: module, timeoutMs, queueSize)`);
    }
  }
  if (typeof o.module !== "string" || o.module.length === 0) throw new Error("captureHook.module must be a path");
  const out: CaptureHookSpec = { module: o.module };
  for (const k of ["timeoutMs", "queueSize"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new Error(`captureHook.${k} must be a positive integer`);
    }
    out[k] = v;
  }
  return out;
}

/** Resolve the module path against the site directory. */
export function resolveHookModule(module: string, siteDir: string): string {
  if (module.startsWith("~/")) return join(homedir(), module.slice(2));
  return isAbsolute(module) ? module : join(siteDir, module);
}

/** Resident hook instances by resolved path, shared across loaders while the source is unchanged. */
const resident = new Map<string, { hash: string; fn: Promise<CaptureHookFn> }>();

/**
 * Load a hook module once and keep it resident. Uses the alias machinery
 * (`bundleAlias` + `evalBundledDefaultExport`), so TypeScript sources work and
 * no cache-busting import() runs in the site worker. The returned loader loads at
 * most once; a later loader for the same path reuses the instance (and its
 * module-level state) unless the source hash changed.
 */
export function createModuleLoader(path: string): () => Promise<CaptureHookFn> {
  let loaded: Promise<CaptureHookFn> | null = null;
  return () => {
    loaded ??= loadResident(path);
    return loaded;
  };
}

async function loadResident(path: string): Promise<CaptureHookFn> {
  const hash = await computeSourceHash(path);
  const cached = resident.get(path);
  if (cached && cached.hash === hash) return cached.fn;
  const fn = (async () => {
    const { js } = await bundleAlias(path);
    const def = await evalBundledDefaultExport(js);
    if (typeof def !== "function") throw new Error(`captureHook module ${path} has no default export function`);
    return def as CaptureHookFn;
  })();
  const entry = { hash, fn };
  resident.set(path, entry);
  fn.catch(() => {
    if (resident.get(path) === entry) resident.delete(path);
  });
  return fn;
}

function interpret(v: unknown): HookOutcome | null {
  if (v === false) return { kind: "drop" };
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { keep?: unknown; meta?: unknown };
  if (o.keep !== undefined && typeof o.keep !== "boolean") return null;
  const meta = o.meta ?? {};
  return o.keep === true ? { kind: "keep", meta } : { kind: "stub", meta };
}

class HookTimeout extends Error {}

/**
 * Bounded FIFO in front of one site's hook. `submit` never blocks: it returns
 * false when the queue is full, and the caller records the response itself.
 */
export class HookRunner {
  readonly stats: HookStats = {
    calls: 0,
    kept: 0,
    stubbed: 0,
    dropped: 0,
    errors: 0,
    timeouts: 0,
    queueFull: 0,
    lastError: null,
  };
  private waiting = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly timeoutMs: number;
  private readonly queueSize: number;

  constructor(
    private load: () => Promise<CaptureHookFn>,
    opts: { timeoutMs?: number; queueSize?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.queueSize = opts.queueSize ?? DEFAULT_HOOK_QUEUE_SIZE;
  }

  /** Queue one call. Returns false (and counts it) when the queue is full. */
  submit(input: { req: CaptureHookRequest; res: CaptureHookResponse }, done: (outcome: HookOutcome) => void): boolean {
    if (this.waiting >= this.queueSize) {
      this.stats.queueFull++;
      return false;
    }
    this.waiting++;
    this.tail = this.tail.then(async () => {
      const outcome = await this.run(input);
      this.waiting--;
      try {
        done(outcome);
      } catch {
        // The writer is best-effort.
      }
    });
    return true;
  }

  /** Resolves once every queued call has finished. */
  drain(): Promise<void> {
    return this.tail;
  }

  /** Start loading the module now, so the first response does not wait for it. */
  preload(): void {
    this.load().catch(() => {
      // Counted when a call hits the same failed load.
    });
  }

  private async run(input: { req: CaptureHookRequest; res: CaptureHookResponse }): Promise<HookOutcome> {
    this.stats.calls++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Loading is not timed: a slow first load (e.g. a model) must not count as a call timeout.
      const fn = await this.load();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HookTimeout()), this.timeoutMs);
      });
      const value = await Promise.race([Promise.resolve().then(() => fn(input)), timeout]);
      const outcome = interpret(value);
      if (!outcome) {
        this.stats.errors++;
        this.stats.lastError = "invalid return value";
        return { kind: "fallback", hook: { error: "invalid-return" } };
      }
      if (outcome.kind === "drop") this.stats.dropped++;
      else if (outcome.kind === "keep") this.stats.kept++;
      else this.stats.stubbed++;
      return outcome;
    } catch (err) {
      if (err instanceof HookTimeout) {
        this.stats.timeouts++;
        return { kind: "fallback", hook: { error: "timeout" } };
      }
      this.stats.errors++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      return { kind: "fallback", hook: { error: "threw" } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
