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
 * Scope, stated honestly: this seals the Bun listener entry points, which is what
 * this codebase actually uses (`bun all the way, no Node.js compat shims`).
 * `node:http`'s exports live on a module namespace object that cannot be
 * redefined, so a determined `import { createServer } from "node:http"` is not
 * closed by this function — the static rule in #3045 is the half that covers it.
 * Two layers, neither sufficient alone.
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

/** True when every listener entry point on `target` has been sealed. */
export function isHttpSealed(target: HttpCapableGlobal = globalThis.Bun as unknown as HttpCapableGlobal): boolean {
  return SEALED_LISTENER_KEYS.every((key) => isKeySealed(target, key));
}
