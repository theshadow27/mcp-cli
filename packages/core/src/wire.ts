/**
 * Wire safety — the invariant that every message crossing a daemon↔worker
 * boundary survives serialization.
 *
 * A domain worker is addressed by `postMessage`/`onmessage` today and becomes a
 * websocket to another host the moment its domain grows a `host` (see
 * `docs/domains.md`). Bun's postMessage uses structured clone, which happily
 * carries `Date`, `Map`, `Set`, cyclic graphs and `undefined` — none of which
 * survive JSON. Code written against structured clone therefore works perfectly
 * until the day the link becomes a socket, and then fails as a silently wrong
 * value rather than as an error.
 *
 * "Everything on the wire must be JSON" is exactly the kind of constraint a
 * reader agrees with and an implementer forgets, so it is a function here and a
 * type below, not a paragraph in a design doc.
 *
 * Two enforcement layers, deliberately both:
 *
 * - **Compile time**: message types are declared as `type` aliases constrained
 *   by {@link JsonValue}, so a field typed `Date` (or an optional field, which
 *   admits `undefined`) is a type error at the declaration site, not a cast a
 *   caller can slip past.
 * - **Run time**: {@link assertWireSafe} on the send path, because the payloads
 *   that actually break this are the ones that arrive as `unknown` from a tool
 *   result or a JSON-RPC argument, where the type system has already lost.
 */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value expressible in JSON. Anything else does not cross the wire. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object. Message types extend this so a non-JSON field fails to typecheck. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Depth limit for the wire-safety walk. Deeper than any real control message,
 * shallow enough that a pathological structure fails fast instead of blowing
 * the stack.
 */
export const MAX_WIRE_DEPTH = 64;

function typeName(value: object): string {
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === null) return "null-prototype object";
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? "object";
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Find the first value in `value` that would not survive a JSON round trip.
 *
 * @returns a human-readable `path: reason` describing the offending value, or
 *          `null` when the whole graph is JSON-safe.
 *
 * Rejects, with the reason each one matters:
 * - `undefined`, functions, symbols — silently dropped from objects, turned
 *   into `null` inside arrays.
 * - `NaN` / `Infinity` — silently become `null`.
 * - `bigint` — `JSON.stringify` throws.
 * - `Date`, `Map`, `Set`, `RegExp`, class instances — either lose their type
 *   (a `Date` arrives as a string that no longer has `.getTime()`) or serialize
 *   to `{}`. Structured clone preserves them, which is precisely the trap.
 * - cycles — `JSON.stringify` throws.
 * - symbol keys — dropped without trace.
 */
export function findWireUnsafeValue(value: unknown, path = "$"): string | null {
  return walk(value, path, new Set<object>(), 0);
}

function walk(value: unknown, path: string, ancestors: Set<object>, depth: number): string | null {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${path}: ${String(value)} is not representable in JSON (becomes null)`;
    case "undefined":
      return `${path}: undefined does not survive JSON`;
    case "function":
      return `${path}: a function cannot cross the wire — pass data, not behaviour`;
    case "symbol":
      return `${path}: a symbol does not survive JSON`;
    case "bigint":
      return `${path}: bigint is not serializable to JSON — send a string or a number`;
    default:
      break;
  }

  const obj = value as object;
  if (ancestors.has(obj)) return `${path}: circular reference`;
  if (depth >= MAX_WIRE_DEPTH) return `${path}: nested deeper than ${MAX_WIRE_DEPTH} levels`;

  if (!Array.isArray(obj) && !isPlainObject(obj)) {
    return `${path}: ${typeName(obj)} survives structured clone but not JSON — send a plain object`;
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const found = walk(obj[i], `${path}[${i}]`, ancestors, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (Object.getOwnPropertySymbols(obj).length > 0) {
      return `${path}: symbol-keyed properties are dropped by JSON`;
    }
    for (const [key, entry] of Object.entries(obj)) {
      const found = walk(entry, `${path}.${key}`, ancestors, depth + 1);
      if (found) return found;
    }
    return null;
  } finally {
    ancestors.delete(obj);
  }
}

/** True when `value` survives a JSON round trip unchanged. */
export function isWireSafe(value: unknown): value is JsonValue {
  return findWireUnsafeValue(value) === null;
}

/** Thrown when a value that must cross a link would not survive JSON. */
export class WireUnsafeError extends Error {
  readonly detail: string;

  constructor(context: string, detail: string) {
    super(`${context} is not wire-safe — ${detail}`);
    this.name = "WireUnsafeError";
    this.detail = detail;
  }
}

/**
 * Throw unless `value` survives a JSON round trip. Returns `value` so it can
 * wrap an expression on the send path.
 *
 * `context` names the message for the error ("domain init", "jsonrpc send").
 */
export function assertWireSafe<T>(value: T, context: string): T {
  const problem = findWireUnsafeValue(value);
  if (problem !== null) throw new WireUnsafeError(context, problem);
  return value;
}
