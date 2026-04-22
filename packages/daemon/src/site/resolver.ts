/**
 * Pure request resolver for NamedCall → concrete HTTP request.
 *
 * Split out from catalog.ts so it's trivially unit-testable without touching
 * the filesystem. `:foo` in the URL is replaced with encodeURIComponent(params.foo);
 * unconsumed params go to the query string (GET/DELETE/HEAD) or JSON body
 * (POST/PUT/PATCH) unless an explicit raw body is provided.
 */

import type { NamedCall } from "./catalog";

export interface ResolvedCall {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  consumedParams: string[];
  residualParams: string[];
}

const URL_PARAM_RE = /:(\w+)/g;
const BODY_METHOD_RE = /^(POST|PUT|PATCH)$/i;

export function resolve(
  call: NamedCall,
  params: Record<string, unknown>,
  rawBody?: string,
  extraHeaders?: Record<string, string>,
): ResolvedCall {
  const consumed: string[] = [];

  let url = call.url.replace(URL_PARAM_RE, (_match, name: string): string => {
    const value = params[name];
    if (value === undefined || value === null) {
      const provided = Object.keys(params).join(", ") || "(none)";
      throw new Error(`Missing required URL param ':${name}' for call '${call.name}'. Provided: ${provided}`);
    }
    consumed.push(name);
    return encodeURIComponent(String(value));
  });

  const residualEntries: [string, unknown][] = [];
  const residual: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (consumed.includes(k)) continue;
    if (v === undefined || v === null) continue;
    residualEntries.push([k, v]);
    residual.push(k);
  }

  const method = (call.method || "GET").toUpperCase();
  const isBodyMethod = BODY_METHOD_RE.test(method);

  let body: string | undefined;
  if (rawBody !== undefined) {
    body = rawBody;
  } else if (isBodyMethod && residualEntries.length > 0 && !call.jq_input) {
    // When the call declares jq_input, the body comes from the jq template
    // in transforms.ts (applyJqInput) — don't short-circuit with a naive
    // residual dump, since applyJqInput skips if a body is already set.
    body = JSON.stringify(Object.fromEntries(residualEntries));
  } else if (!isBodyMethod && residualEntries.length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of residualEntries) qs.set(k, String(v));
    url = url + (url.includes("?") ? "&" : "?") + qs.toString();
  }

  const headers: Record<string, string> = {
    ...(call.headers ?? {}),
    ...(extraHeaders ?? {}),
  };
  if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }

  return { url, method, body, headers, consumedParams: consumed, residualParams: residual };
}
