/**
 * A domain worker serves no HTTP.
 *
 * The rule exists because project code and the web surface fail differently and
 * neither should take the other down: domain workers run phases, automation,
 * sensors and the reducer; the console worker (epic H) serves HTTP for every
 * domain and runs no project code. A crashing page must not stop project
 * execution, and a wedged phase must not black out the console.
 *
 * "Do not open a listener" is prose, and prose is what an implementation under
 * pressure rationalizes past — one debug endpoint, one health check, one metrics
 * port. So the entry points are removed from the worker's global instead: after
 * {@link sealNoHttp}, `Bun.serve` in that thread throws.
 *
 * **Sealing is necessary and not sufficient, and the difference matters.**
 * {@link isHttpSealed} answers "is the marker present", which is a proxy.
 * {@link verifyCannotListen} answers "can this thread open a port", by trying —
 * and that is what the worker reports and what #3045's rule must be able to
 * trust. A rule that passes on a marker passes on a worker that can listen.
 *
 * **Ordering is the other half.** Redefining a property does not reach a value
 * already copied out of it, so a module evaluated before the seal that did
 * `const f = Bun.serve` keeps a working reference. Measured on Bun 1.4.0, a
 * named `import { serve } from "bun"` is a *live* binding and does follow the
 * seal — but a value copy does not. The worker therefore seals as an import side
 * effect (`domain/autoseal.ts`) ahead of its own graph, rather than in its init
 * handler where every module has already evaluated.
 *
 * Scope, stated honestly: this covers the Bun listener entry points, which is
 * what this codebase actually uses (`bun all the way, no Node.js compat shims`).
 * The `node:http`, `node:net`, `node:dgram`, `node:http2` and `node:tls` exports
 * live on module namespace objects that cannot be redefined at all, so a
 * determined `import { createServer } from "node:http"` is not closed here — the
 * static rule in #3045 is the half that covers it. Layers, none sufficient alone.
 */

/** The subset of the Bun global this module removes. */
export interface HttpCapableGlobal {
  serve?: unknown;
  listen?: unknown;
  udpSocket?: unknown;
}

/** The listener entry points a domain worker must not have. */
export const SEALED_LISTENER_KEYS = ["serve", "listen", "udpSocket"] as const;

export type SealedListenerKey = (typeof SEALED_LISTENER_KEYS)[number];

/** Thrown when a sealed listener entry point is called. */
export class HttpForbiddenError extends Error {
  constructor(key: string) {
    super(
      `Bun.${key} is not available in a domain worker: a domain worker runs project code and serves no HTTP. The console worker is the process that serves HTTP (docs/domains.md, "Workers").`,
    );
    this.name = "HttpForbiddenError";
  }
}

/** Thrown at worker startup when the listener entry points could not be removed. */
export class HttpSealFailedError extends Error {
  constructor(key: string, cause: unknown) {
    super(
      `Could not seal Bun.${key} in the domain worker (${cause instanceof Error ? cause.message : String(cause)}). Refusing to start: an unsealed worker can open a listener, which is the failure this guard exists to prevent.`,
    );
    this.name = "HttpSealFailedError";
  }
}

const SEAL_MARKER = Symbol.for("mcx.domain-worker.no-http");

/** Build the replacement for one listener entry point. Identity is how {@link isHttpSealed} recognises a seal. */
function refuseFor(key: SealedListenerKey): () => never {
  const refuse = (): never => {
    throw new HttpForbiddenError(key);
  };
  Object.defineProperty(refuse, SEAL_MARKER, { value: key, enumerable: false });
  return refuse;
}

/**
 * Replace every listener entry point on `target` with a thrower.
 *
 * Idempotent. Throws {@link HttpSealFailedError} if any entry point survives —
 * a runtime that no longer permits the seal is something to hear about at
 * startup, not to discover from a domain worker holding a socket open.
 *
 * `target` is injectable so the guard can be tested against a stand-in instead
 * of mutating the test runner's own `Bun`.
 */
export function sealNoHttp(target: HttpCapableGlobal = globalThis.Bun as unknown as HttpCapableGlobal): void {
  for (const key of SEALED_LISTENER_KEYS) {
    if (isKeySealed(target, key)) continue;
    const refuse = refuseFor(key);
    try {
      Object.defineProperty(target, key, { value: refuse, writable: false, enumerable: true, configurable: false });
    } catch (err) {
      throw new HttpSealFailedError(key, err);
    }
    if (!isKeySealed(target, key)) {
      throw new HttpSealFailedError(key, "the property was not replaced");
    }
  }
}

function isKeySealed(target: HttpCapableGlobal, key: SealedListenerKey): boolean {
  const value = (target as Record<string, unknown>)[key];
  if (typeof value !== "function") return false;
  return Object.getOwnPropertyDescriptor(value, SEAL_MARKER)?.value === key;
}

/**
 * True when every listener entry point on `target` carries the seal marker.
 *
 * **This is not the property.** It says a marker is present, which is a proxy
 * for "cannot listen" and not the thing itself — and a proxy is exactly what
 * #3045's rule must not be allowed to pass on. Use {@link verifyCannotListen}
 * when the answer has to be true rather than plausible.
 */
export function isHttpSealed(target: HttpCapableGlobal = globalThis.Bun as unknown as HttpCapableGlobal): boolean {
  return SEALED_LISTENER_KEYS.every((key) => isKeySealed(target, key));
}

/** What {@link verifyCannotListen} found when it actually tried to open a port. */
export type ListenVerification = { canListen: false } | { canListen: true; via: string; detail: string };

/**
 * Determine, by trying it, whether this thread can open a listening socket.
 *
 * Derived from the thing itself rather than from a marker. The distinction is
 * not pedantic: a static `import { serve } from "bun"` evaluated *before* the
 * seal keeps a live pre-seal reference and opens a real port while
 * {@link isHttpSealed} still answers `true`. A marker cannot see that; a bind
 * attempt can.
 *
 * If a listener does open, it is stopped immediately — the point is to learn the
 * answer, not to serve anything. Reporting `canListen: true` is the failure
 * signal; the caller decides what to do about it (the domain worker refuses to
 * start).
 */
export function verifyCannotListen(): ListenVerification {
  const bun = globalThis.Bun as unknown as {
    serve?: (options: unknown) => { stop?: (force?: boolean) => void; port?: number };
    listen?: (options: unknown) => { stop?: (force?: boolean) => void; port?: number };
  };

  const serveProbe = probe(() => bun.serve?.({ port: 0, fetch: () => new Response("") }));
  if (serveProbe) return { canListen: true, via: "Bun.serve", detail: serveProbe };

  const listenProbe = probe(() => bun.listen?.({ hostname: "127.0.0.1", port: 0, socket: { data(): void {} } }));
  if (listenProbe) return { canListen: true, via: "Bun.listen", detail: listenProbe };

  return { canListen: false };
}

/**
 * Run one bind attempt. Returns a description when a listener actually opened
 * (after stopping it), or `null` when the attempt was refused — which is the
 * outcome this guard wants.
 */
function probe(open: () => { stop?: (force?: boolean) => void; port?: number } | undefined): string | null {
  let opened: { stop?: (force?: boolean) => void; port?: number } | undefined;
  try {
    opened = open();
  } catch {
    return null; // refused — either by the seal or by the runtime. Either way it cannot listen.
  }
  if (!opened) return null;
  const where = typeof opened.port === "number" ? `port ${opened.port}` : "an unreported port";
  try {
    opened.stop?.(true);
  } catch {
    // best effort — the finding is that it opened at all
  }
  return `a listener opened on ${where}`;
}

/** Thrown at worker startup when a bind attempt succeeds despite the seal. */
export class HttpStillReachableError extends Error {
  constructor(verification: Extract<ListenVerification, { canListen: true }>) {
    super(
      `A domain worker was able to open a listening socket via ${verification.via} (${verification.detail}) even though the listener entry points report sealed. A pre-seal reference — a static \`import { serve } from "bun"\` evaluated before the seal — survives it. Refusing to start.`,
    );
    this.name = "HttpStillReachableError";
  }
}
