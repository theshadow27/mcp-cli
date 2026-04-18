import { describe, expect, test } from "bun:test";
import type { NamedCall } from "./catalog";
import { resolve } from "./resolver";

const GET_CALL: NamedCall = {
  name: "get_thing",
  method: "GET",
  url: "https://api.example.com/v1/things/:thingId",
};

const POST_CALL: NamedCall = {
  name: "make_thing",
  method: "POST",
  url: "https://api.example.com/v1/things",
  headers: { "x-custom": "1" },
};

describe("resolve", () => {
  test("substitutes URL path params with encoding", () => {
    const r = resolve(GET_CALL, { thingId: "a b/c" });
    expect(r.url).toBe("https://api.example.com/v1/things/a%20b%2Fc");
    expect(r.consumedParams).toEqual(["thingId"]);
    expect(r.residualParams).toEqual([]);
    expect(r.body).toBeUndefined();
  });

  test("throws on missing URL param", () => {
    expect(() => resolve(GET_CALL, {})).toThrow(/Missing required URL param/);
  });

  test("GET residual params flow to query string", () => {
    const r = resolve(GET_CALL, { thingId: "abc", limit: 10, q: "hi" });
    expect(r.url).toMatch(/\?limit=10&q=hi$/);
    expect(r.residualParams).toContain("limit");
    expect(r.residualParams).toContain("q");
  });

  test("POST residual params go to JSON body with content-type default", () => {
    const r = resolve(POST_CALL, { name: "foo", count: 3 });
    expect(r.body).toBe(JSON.stringify({ name: "foo", count: 3 }));
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["x-custom"]).toBe("1");
  });

  test("explicit raw body overrides residual body construction", () => {
    const r = resolve(POST_CALL, { ignored: "x" }, "raw=payload", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(r.body).toBe("raw=payload");
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("null/undefined params are dropped", () => {
    const r = resolve(GET_CALL, { thingId: "x", a: null, b: undefined, c: 0 });
    expect(r.residualParams).toEqual(["c"]);
  });

  test("preserves existing query string when appending", () => {
    const call: NamedCall = { name: "x", method: "GET", url: "https://api.example.com/v1/things?fixed=1" };
    const r = resolve(call, { extra: "yes" });
    expect(r.url).toBe("https://api.example.com/v1/things?fixed=1&extra=yes");
  });
});
