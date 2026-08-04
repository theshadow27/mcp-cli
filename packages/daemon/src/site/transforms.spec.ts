import { describe, expect, test } from "bun:test";
import type { NamedCall } from "./catalog";
import type { ProxyCallResult } from "./proxy";
import type { ResolvedCall } from "./resolver";
import {
  FETCH_FILTERS,
  type JqRunner,
  applyFetchFilter,
  applyJqInput,
  applyJqOutput,
  applyVarHeaders,
  isSafeHeaderValue,
} from "./transforms";

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

const BASE_CALL: NamedCall = { name: "t", url: "https://e.example/x", method: "POST" };
const BASE_RESOLVED: ResolvedCall = {
  url: "https://e.example/x",
  method: "POST",
  headers: {},
  consumedParams: [],
  residualParams: [],
};
const BASE_RESULT: ProxyCallResult = {
  status: 200,
  url: "https://e.example/x",
  method: "POST",
  usedAud: "aud",
  responseHeaders: {},
  body: {},
};

const recordingJq = (impl: (expr: string, input: string) => string) => {
  const calls: Array<{ expr: string; input: string }> = [];
  const runner: JqRunner = async (expr, input) => {
    calls.push({ expr, input });
    return impl(expr, input);
  };
  return { runner, calls };
};

describe("applyJqInput", () => {
  test("no-op when body already resolved", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_input: "." };
    const { runner, calls } = recordingJq(() => "{}");
    const out = await applyJqInput(call, {}, { ...BASE_RESOLVED, body: "keep" }, runner);
    expect(out.body).toBe("keep");
    expect(calls).toHaveLength(0);
  });

  test("no-op when jq_input not set", async () => {
    const { runner, calls } = recordingJq(() => "{}");
    const out = await applyJqInput(BASE_CALL, { q: "foo" }, BASE_RESOLVED, runner);
    expect(out.body).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("shapes body from params + body_default", async () => {
    const call: NamedCall = {
      ...BASE_CALL,
      jq_input: ".body_default + {query: .params.q}",
      body_default: { limit: 10 },
    };
    const { runner, calls } = recordingJq(() => JSON.stringify({ limit: 10, query: "hi" }));
    const out = await applyJqInput(call, { q: "hi" }, BASE_RESOLVED, runner);
    expect(out.body).toBe('{"limit":10,"query":"hi"}');
    expect(out.headers["content-type"]).toBe("application/json");
    expect(calls[0].input).toBe(JSON.stringify({ params: { q: "hi" }, body_default: { limit: 10 }, vars: {} }));
  });

  test("passes null body_default when call omits it", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_input: "." };
    const { runner, calls } = recordingJq(() => "null");
    await applyJqInput(call, { x: 1 }, BASE_RESOLVED, runner);
    expect(calls[0].input).toBe(JSON.stringify({ params: { x: 1 }, body_default: null, vars: {} }));
  });

  test("exposes captured vars to the template", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_input: "{id: .vars.inboxFolderId}" };
    const { runner, calls } = recordingJq(() => '{"id":"AAMk="}');
    await applyJqInput(call, {}, BASE_RESOLVED, runner, { inboxFolderId: "AAMk=" });
    expect(JSON.parse(calls[0].input).vars).toEqual({ inboxFolderId: "AAMk=" });
  });

  test("preserves caller-supplied content-type header", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_input: "." };
    const { runner } = recordingJq(() => "a=b");
    const out = await applyJqInput(call, {}, { ...BASE_RESOLVED, headers: { "Content-Type": "text/plain" } }, runner);
    expect(out.headers["Content-Type"]).toBe("text/plain");
    expect(out.headers["content-type"]).toBeUndefined();
  });

  test("propagates jq runner errors", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_input: "boom" };
    const runner: JqRunner = async () => {
      throw new Error("jq exited 3: parse error");
    };
    await expect(applyJqInput(call, {}, BASE_RESOLVED, runner)).rejects.toThrow(/parse error/);
  });
});

describe("applyVarHeaders", () => {
  test("substitutes a captured var into a header value", () => {
    const resolved = { ...BASE_RESOLVED, headers: { "x-anchormailbox": "${anchorMailbox}", "x-req-source": "Mail" } };
    const out = applyVarHeaders(resolved, { anchorMailbox: "PUID:abc@tenant" });
    expect(out.headers).toEqual({ "x-anchormailbox": "PUID:abc@tenant", "x-req-source": "Mail" });
  });

  test("drops headers whose vars were never captured", () => {
    const resolved = { ...BASE_RESOLVED, headers: { "x-anchormailbox": "${anchorMailbox}", "x-owa-canary": "" } };
    const out = applyVarHeaders(resolved, {});
    expect(out.headers).toEqual({ "x-owa-canary": "" });
  });

  test("drops a header when a captured var is present but empty", () => {
    const resolved = { ...BASE_RESOLVED, headers: { "x-anchormailbox": "${anchorMailbox}" } };
    expect(applyVarHeaders(resolved, { anchorMailbox: "" }).headers).toEqual({});
  });

  test("substitutes repeated and multiple vars in one value", () => {
    const resolved = { ...BASE_RESOLVED, headers: { combo: "${a}/${b}/${a}" } };
    const out = applyVarHeaders(resolved, { a: "1", b: "2" });
    expect(out.headers.combo).toBe("1/2/1");
  });

  test("leaves var-free headers untouched across repeated calls", () => {
    const resolved = { ...BASE_RESOLVED, headers: { a: "plain", b: "also plain" } };
    expect(applyVarHeaders(resolved, {}).headers).toEqual({ a: "plain", b: "also plain" });
    expect(applyVarHeaders(resolved, {}).headers).toEqual({ a: "plain", b: "also plain" });
  });

  test("drops a header rather than letting a captured CRLF forge another header", () => {
    const resolved = { ...BASE_RESOLVED, headers: { "x-anchormailbox": "${anchorMailbox}", keep: "plain" } };
    const out = applyVarHeaders(resolved, { anchorMailbox: "id\r\nx-injected: 1" });
    expect(out.headers).toEqual({ keep: "plain" });
  });

  test("drops a header whose captured var carries any other control character", () => {
    const resolved = { ...BASE_RESOLVED, headers: { h: "${v}" } };
    expect(applyVarHeaders(resolved, { v: `a${NUL}b` }).headers).toEqual({});
    expect(applyVarHeaders(resolved, { v: `a${DEL}b` }).headers).toEqual({});
  });
});

describe("isSafeHeaderValue", () => {
  test("accepts the shapes a captured identity or folder value actually takes", () => {
    expect(isSafeHeaderValue("user@example.com")).toBe(true);
    expect(isSafeHeaderValue("PUID:0123ABCD@example.com")).toBe(true);
    expect(isSafeHeaderValue("AAMkAGZvbGRlcgAuAAAAAAEMAAA=")).toBe(true);
  });

  test("rejects CR, LF, tab, NUL, and DEL", () => {
    expect(isSafeHeaderValue("a\rb")).toBe(false);
    expect(isSafeHeaderValue("a\nb")).toBe(false);
    expect(isSafeHeaderValue("a\tb")).toBe(false);
    expect(isSafeHeaderValue(`a${NUL}b`)).toBe(false);
    expect(isSafeHeaderValue(`a${DEL}b`)).toBe(false);
  });
});

describe("applyFetchFilter", () => {
  test("no-op when fetchFilter not set", () => {
    expect(applyFetchFilter(BASE_CALL, BASE_RESOLVED)).toEqual(BASE_RESOLVED);
  });

  test("throws on unknown filter", () => {
    const call: NamedCall = { ...BASE_CALL, fetchFilter: "nope" };
    expect(() => applyFetchFilter(call, BASE_RESOLVED)).toThrow(/Unknown fetchFilter 'nope'/);
  });

  test("owa-urlpostdata moves body into x-owa-urlpostdata header", () => {
    const call: NamedCall = { ...BASE_CALL, fetchFilter: "owa-urlpostdata" };
    const resolved: ResolvedCall = { ...BASE_RESOLVED, body: '{"a":1,"b":"x y"}' };
    const out = applyFetchFilter(call, resolved);
    expect(out.body).toBeUndefined();
    expect(out.headers["x-owa-urlpostdata"]).toBe(encodeURIComponent('{"a":1,"b":"x y"}'));
  });

  test("owa-urlpostdata leaves empty body untouched", () => {
    const call: NamedCall = { ...BASE_CALL, fetchFilter: "owa-urlpostdata" };
    const out = applyFetchFilter(call, BASE_RESOLVED);
    expect(out.body).toBeUndefined();
    expect(out.headers["x-owa-urlpostdata"]).toBeUndefined();
  });

  test("FETCH_FILTERS registry exposes owa-urlpostdata", () => {
    expect(typeof FETCH_FILTERS["owa-urlpostdata"]).toBe("function");
  });
});

describe("applyJqOutput", () => {
  test("no-op when jq_output not set", async () => {
    const { runner, calls } = recordingJq(() => "x");
    const out = await applyJqOutput(BASE_CALL, BASE_RESULT, runner);
    expect(out).toEqual(BASE_RESULT);
    expect(calls).toHaveLength(0);
  });

  test("no-op when body is null", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_output: "." };
    const { runner, calls } = recordingJq(() => "x");
    const out = await applyJqOutput(call, { ...BASE_RESULT, body: null }, runner);
    expect(out.body).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("parses JSON jq output into a value", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_output: "{total: .count}" };
    const { runner, calls } = recordingJq(() => '{"total":5}');
    const out = await applyJqOutput(call, { ...BASE_RESULT, body: { count: 5 } }, runner);
    expect(out.body).toEqual({ total: 5 });
    expect(calls[0].input).toBe(JSON.stringify({ count: 5 }));
  });

  test("falls back to trimmed string when jq output is not JSON", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_output: ".name" };
    const { runner } = recordingJq(() => "hello\n");
    const out = await applyJqOutput(call, { ...BASE_RESULT, body: { name: "hello" } }, runner);
    expect(out.body).toBe("hello");
  });

  test("preserves all non-body fields", async () => {
    const call: NamedCall = { ...BASE_CALL, jq_output: "." };
    const { runner } = recordingJq(() => '{"x":1}');
    const out = await applyJqOutput(
      call,
      { ...BASE_RESULT, status: 201, usedAud: "a", responseHeaders: { etag: "W/x" } },
      runner,
    );
    expect(out.status).toBe(201);
    expect(out.usedAud).toBe("a");
    expect(out.responseHeaders.etag).toBe("W/x");
  });
});
