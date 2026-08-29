import { describe, expect, test } from "bun:test";
import {
  ThreadsFileSchema,
  deniedWriteThread,
  isWriteMethod,
  listThreads,
  loadThreads,
  nameForThreadId,
  parseThreadsText,
  postPolicyForThreadId,
  resolveThreadId,
  resolveThreadParams,
  watchedThreadIds,
} from "./threads";

const YAML = `
general:
  id: "19:aaa@thread.v2"
  post: deny
  notes: "broadcast, read only"
  watch: true
devs:
  id: "19:bbb@thread.v2"
  post: allow
`;

describe("parseThreadsText", () => {
  test("parses YAML with defaults", () => {
    const t = parseThreadsText(YAML, "yaml");
    expect(t.general.id).toBe("19:aaa@thread.v2");
    expect(t.general.post).toBe("deny");
    expect(t.general.watch).toBe(true);
    expect(t.devs.post).toBe("allow");
    expect(t.devs.watch).toBeUndefined();
  });

  test("parses JSON of the same shape", () => {
    const t = parseThreadsText('{"x":{"id":"19:ccc@thread.v2"}}', "json");
    expect(t.x.id).toBe("19:ccc@thread.v2");
    expect(t.x.post).toBe("allow");
  });

  test("treats an empty document as no threads", () => {
    expect(parseThreadsText("", "yaml")).toEqual({});
  });

  test("rejects a malformed entry", () => {
    expect(() => parseThreadsText("bad:\n  post: deny\n", "yaml")).toThrow();
  });
});

describe("loadThreads", () => {
  test("returns {} when no file exists", () => {
    expect(loadThreads("teams", () => null)).toEqual({});
  });

  test("prefers yaml over json", () => {
    const reader = (path: string): string | null => {
      if (path.endsWith("threads.yaml")) return YAML;
      if (path.endsWith("threads.json")) return '{"other":{"id":"19:zzz@thread.v2"}}';
      return null;
    };
    const t = loadThreads("teams", reader);
    expect(t.general).toBeDefined();
    expect(t.other).toBeUndefined();
  });

  test("falls back to json when yaml is absent", () => {
    const reader = (path: string): string | null =>
      path.endsWith("threads.json") ? '{"other":{"id":"19:zzz@thread.v2"}}' : null;
    const t = loadThreads("teams", reader);
    expect(t.other.id).toBe("19:zzz@thread.v2");
  });
});

describe("resolution + policy", () => {
  const threads = ThreadsFileSchema.parse({
    general: { id: "19:aaa@thread.v2", post: "deny" },
    devs: { id: "19:bbb@thread.v2", post: "allow" },
  });

  test("resolveThreadId maps a name", () => {
    expect(resolveThreadId(threads, "general")).toBe("19:aaa@thread.v2");
  });
  test("resolveThreadId passes an unknown id through", () => {
    expect(resolveThreadId(threads, "19:raw@thread.v2")).toBe("19:raw@thread.v2");
  });
  test("nameForThreadId reverse-resolves", () => {
    expect(nameForThreadId(threads, "19:bbb@thread.v2")).toBe("devs");
    expect(nameForThreadId(threads, "19:unknown@thread.v2")).toBeUndefined();
  });
  test("postPolicyForThreadId returns the policy, allow by default", () => {
    expect(postPolicyForThreadId(threads, "19:aaa@thread.v2")).toBe("deny");
    expect(postPolicyForThreadId(threads, "19:bbb@thread.v2")).toBe("allow");
    expect(postPolicyForThreadId(threads, "19:unknown@thread.v2")).toBe("allow");
  });
});

describe("listing + watch set", () => {
  const threads = parseThreadsText(YAML, "yaml");
  test("listThreads returns sorted rows", () => {
    const rows = listThreads(threads);
    expect(rows.map((r) => r.name)).toEqual(["devs", "general"]);
    expect(rows[1]).toEqual({
      name: "general",
      id: "19:aaa@thread.v2",
      post: "deny",
      notes: "broadcast, read only",
      watch: true,
    });
  });
  test("watchedThreadIds returns only watch:true ids", () => {
    expect(watchedThreadIds(threads)).toEqual(["19:aaa@thread.v2"]);
  });
});

describe("isWriteMethod", () => {
  test.each(["POST", "put", "Patch", "DELETE"])("%s is a write", (m) => {
    expect(isWriteMethod(m)).toBe(true);
  });
  test.each(["GET", "HEAD"])("%s is not a write", (m) => {
    expect(isWriteMethod(m)).toBe(false);
  });
});

describe("resolveThreadParams", () => {
  const threads = ThreadsFileSchema.parse({ general: { id: "19:aaa@thread.v2", post: "deny" } });
  test("rewrites a thread-name param to its id", () => {
    const params: Record<string, unknown> = { threadId: "general", pageSize: 20 };
    resolveThreadParams(threads, params);
    expect(params.threadId).toBe("19:aaa@thread.v2");
    expect(params.pageSize).toBe(20);
  });
  test("leaves a raw id untouched", () => {
    const params: Record<string, unknown> = { conversationId: "19:raw@thread.v2" };
    resolveThreadParams(threads, params);
    expect(params.conversationId).toBe("19:raw@thread.v2");
  });
});

describe("deniedWriteThread", () => {
  const threads = ThreadsFileSchema.parse({
    general: { id: "19:aaa@thread.v2", post: "deny" },
    devs: { id: "19:bbb@thread.v2", post: "allow" },
  });

  test("refuses a POST to a denied thread by resolved id", () => {
    expect(deniedWriteThread(threads, { threadId: "19:aaa@thread.v2" }, "POST")).toBe("19:aaa@thread.v2");
  });
  test("allows a GET to a denied thread (reads are fine)", () => {
    expect(deniedWriteThread(threads, { threadId: "19:aaa@thread.v2" }, "GET")).toBeNull();
  });
  test("allows a POST to an allow thread", () => {
    expect(deniedWriteThread(threads, { threadId: "19:bbb@thread.v2" }, "POST")).toBeNull();
  });
  test("catches the raw denied id even without a name (no bypass)", () => {
    // resolveThreadParams is a no-op on a raw id, but the deny lookup is by id.
    const params = { threadId: "19:aaa@thread.v2" };
    resolveThreadParams(threads, params);
    expect(deniedWriteThread(threads, params, "DELETE")).toBe("19:aaa@thread.v2");
  });
});
