/**
 * Named-call transforms that run around resolver/proxy.
 *
 * The resolver is pure (params → ResolvedCall) and the proxy is credential-
 * focused (ResolvedCall → response). The in-between is catalog-declarative:
 *
 *   - `jq_input`    reshape params (plus optional `body_default`) into a body
 *                   when the resolver didn't produce one
 *   - `fetchFilter` rewrite the final {url, method, headers, body} tuple
 *                   before it hits the proxy — e.g. OWA's x-owa-urlpostdata
 *   - `jq_output`   reshape the proxy's response body before returning
 *
 * The jq runner is injectable so tests don't need the external `jq` binary.
 */

import type { NamedCall } from "./catalog";
import type { ProxyCallResult } from "./proxy";
import type { ResolvedCall } from "./resolver";

/** Injection point for the jq binary so tests don't require it. */
export type JqRunner = (expression: string, input: string) => Promise<string>;

/** Default runner: shells out to the external `jq` binary via Bun.spawn. */
export const bunJqRunner: JqRunner = async (expression, input) => {
  const proc = Bun.spawn(["jq", "-c", expression], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.stdin) throw new Error("jq spawn did not expose stdin");
  proc.stdin.write(input);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`jq exited ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
};

/**
 * If the call declares `jq_input` and the resolver produced no body, shape a
 * body from `{ params, body_default }` via jq. Otherwise returns unchanged.
 */
export async function applyJqInput(
  call: NamedCall,
  params: Record<string, unknown>,
  resolved: ResolvedCall,
  jq: JqRunner = bunJqRunner,
): Promise<ResolvedCall> {
  if (resolved.body !== undefined || !call.jq_input) return resolved;
  const input = JSON.stringify({ params, body_default: call.body_default ?? null });
  const body = (await jq(call.jq_input, input)).trim();
  const headers = { ...resolved.headers };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  return { ...resolved, body, headers };
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
 * If the call declares `jq_output` and the proxy returned a non-null body,
 * reshape it. jq stdout that parses as JSON is returned as a value; otherwise
 * the trimmed text is returned verbatim.
 */
export async function applyJqOutput(
  call: NamedCall,
  result: ProxyCallResult,
  jq: JqRunner = bunJqRunner,
): Promise<ProxyCallResult> {
  if (!call.jq_output || result.body === undefined || result.body === null) return result;
  const shaped = await jq(call.jq_output, JSON.stringify(result.body));
  let body: unknown;
  try {
    body = JSON.parse(shaped);
  } catch {
    body = shaped.trim();
  }
  return { ...result, body };
}
