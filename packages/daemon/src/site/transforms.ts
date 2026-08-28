/**
 * Named-call transforms that run around resolver/proxy.
 *
 * The resolver is pure (params → ResolvedCall) and the proxy is credential-
 * focused (ResolvedCall → response). The in-between is catalog-declarative:
 *
 *   - `jq_input`    reshape params (plus optional `body_default` and captured
 *                   `vars`) into a body when the resolver didn't produce one
 *   - `applyVarHeaders` substitute `${name}` in headers from captured vars,
 *                   dropping headers whose vars were never captured
 *   - `fetchFilter` rewrite the final {url, method, headers, body} tuple
 *                   before it hits the proxy — e.g. OWA's x-owa-urlpostdata
 *   - `jq_output`   reshape the proxy's response body before returning, with
 *                   the request `params` and captured `vars` available as the
 *                   jq named args `$params` / `$vars`
 *
 * `jq_input` gets its extras in the jq *input* document (`{ params,
 * body_default, vars }`); `jq_output` gets them as *named args* instead, so the
 * input document stays the bare response body and every existing `jq_output`
 * expression keeps working unchanged.
 *
 * The jq runner is injectable so tests don't need the external `jq` binary.
 */

import { spawnCapture } from "@mcp-cli/core";
import type { NamedCall } from "./catalog";
import type { ProxyCallResult } from "./proxy";
import type { ResolvedCall } from "./resolver";

/**
 * Injection point for the jq binary so tests don't require it.
 *
 * `namedArgs` are bound as jq named arguments (`$name`), not merged into the
 * input document — that keeps the input shape stable for existing expressions.
 */
export type JqRunner = (expression: string, input: string, namedArgs?: Record<string, unknown>) => Promise<string>;

/**
 * argv for one jq invocation. Named args are passed as `--argjson` so jq parses
 * them as JSON values rather than strings, and `undefined` is normalized to
 * `null` because `JSON.stringify(undefined)` is not valid jq input. Exported so
 * the argv construction is testable without the jq binary.
 */
export function jqArgs(expression: string, namedArgs?: Record<string, unknown>): string[] {
  const args = ["-c"];
  for (const [name, value] of Object.entries(namedArgs ?? {})) {
    args.push("--argjson", name, JSON.stringify(value ?? null));
  }
  args.push(expression);
  return args;
}

/** Default runner: shells out to the external `jq` binary via spawnCapture. */
export const bunJqRunner: JqRunner = async (expression, inputStr, namedArgs) => {
  const result = await spawnCapture("jq", jqArgs(expression, namedArgs), { input: inputStr });
  if (!result.ok) {
    if (result.exitCode === null) {
      throw new Error("failed to spawn jq (not found on PATH?)");
    }
    throw new Error(`jq exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

/**
 * If the call declares `jq_input` and the resolver produced no body, shape a
 * body from `{ params, body_default, vars }` via jq. Otherwise returns unchanged.
 *
 * `vars` carries per-account values captured by `mcx site capture`, letting a
 * template prefer a concrete account-specific id and fall back to a generic alias.
 */
export async function applyJqInput(
  call: NamedCall,
  params: Record<string, unknown>,
  resolved: ResolvedCall,
  jq: JqRunner = bunJqRunner,
  vars: Record<string, string> = {},
): Promise<ResolvedCall> {
  if (resolved.body !== undefined || !call.jq_input) return resolved;
  const input = JSON.stringify({ params, body_default: call.body_default ?? null, vars });
  const body = (await jq(call.jq_input, input)).trim();
  const headers = { ...resolved.headers };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  return { ...resolved, body, headers };
}

const VAR_RE = /\$\{(\w+)\}/g;

/**
 * A captured var is scraped from whatever the site's traffic happened to
 * contain, so it is untrusted input on the way to a header value. CR/LF would
 * let it forge additional headers, and other control characters are rejected by
 * fetch() anyway — better to drop the header than to fail the whole call.
 */
const CONTROL_CHAR_MAX = 0x1f;
const DELETE_CHAR = 0x7f;

export function isSafeHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= CONTROL_CHAR_MAX || code === DELETE_CHAR) return false;
  }
  return true;
}

/**
 * Substitute `${name}` in header values from captured vars. A header is dropped
 * rather than sent when its value still references an uncaptured var, or when a
 * substituted var would make the value unsafe — a seed can declare an
 * account-specific header unconditionally and it simply doesn't appear until
 * `mcx site capture` has produced a usable value.
 */
export function applyVarHeaders(resolved: ResolvedCall, vars: Record<string, string>): ResolvedCall {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved.headers)) {
    let unresolved = false;
    const substituted = value.replace(VAR_RE, (_m, name: string): string => {
      const v = vars[name];
      if (v === undefined || v === "" || !isSafeHeaderValue(v)) {
        unresolved = true;
        return "";
      }
      return v;
    });
    if (!unresolved) headers[key] = substituted;
  }
  return { ...resolved, headers };
}

/** Synchronous rewrite of a ResolvedCall. */
type FetchFilter = (resolved: ResolvedCall) => ResolvedCall;

/**
 * Named registry. Catalog entries pick one via `fetchFilter`; unknown names
 * fail loudly in applyFetchFilter rather than silently misrouting.
 */
export const FETCH_FILTERS: Record<string, FetchFilter> = {
  /** OWA posts JSON bodies as URL-encoded values in the x-owa-urlpostdata header. */
  "owa-urlpostdata": (r) => {
    if (!r.body) return r;
    const headers = { ...r.headers };
    headers["x-owa-urlpostdata"] = encodeURIComponent(r.body);
    return { ...r, body: undefined, headers };
  },
};

export function applyFetchFilter(call: NamedCall, resolved: ResolvedCall): ResolvedCall {
  if (!call.fetchFilter) return resolved;
  const filter = FETCH_FILTERS[call.fetchFilter];
  if (!filter) {
    throw new Error(
      `Unknown fetchFilter '${call.fetchFilter}' on call '${call.name}'. Known: ${Object.keys(FETCH_FILTERS).join(", ") || "(none)"}`,
    );
  }
  return filter(resolved);
}

/**
 * Per-account and per-request context made available to `jq_output` as jq named
 * args. Both are always bound, defaulting to `{}`, so an expression can say
 * `$vars.me_mri` or `$params.threadId` without first testing that the key
 * exists — an uncaptured var reads as `null`, not a jq error.
 */
export interface JqOutputContext {
  /** Per-account values captured by `mcx site capture` (`$vars`). */
  vars?: Record<string, string>;
  /** The request params the call was invoked with (`$params`). */
  params?: Record<string, unknown>;
}

/**
 * If the call declares `jq_output` and the proxy returned a non-null body,
 * reshape it. jq stdout that parses as JSON is returned as a value; otherwise
 * the trimmed text is returned verbatim.
 *
 * The jq input is the bare response body. The account's captured `vars` and the
 * request `params` are bound as the named args `$vars` / `$params` instead, so a
 * response transform can compute account-relative fields — e.g.
 * `is_me: (.from.mri == $vars.me_mri)` — without changing the input shape.
 */
export async function applyJqOutput(
  call: NamedCall,
  result: ProxyCallResult,
  jq: JqRunner = bunJqRunner,
  ctx: JqOutputContext = {},
): Promise<ProxyCallResult> {
  if (!call.jq_output || result.body === undefined || result.body === null) return result;
  const shaped = await jq(call.jq_output, JSON.stringify(result.body), {
    vars: ctx.vars ?? {},
    params: ctx.params ?? {},
  });
  let body: unknown;
  try {
    body = JSON.parse(shaped);
  } catch {
    body = shaped.trim();
  }
  return { ...result, body };
}
