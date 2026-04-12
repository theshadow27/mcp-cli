/**
 * Unit tests for the in-memory MockProvider used by t5801 integration specs.
 *
 * The mock is reusable by #1211 (import handler) and #1212 (export handler)
 * once those land, so it's worth a dedicated coverage pass.
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedScope } from "../../providers/provider";
import { createMockProvider } from "./mock-provider";

const SCOPE: ResolvedScope = { key: "test", cloudId: "mock-cloud", resolved: {} };

describe("MockProvider", () => {
  test("resolveScope returns key+cloudId, defaults cloudId", async () => {
    const p = createMockProvider();
    const resolved = await p.resolveScope({ key: "X" });
    expect(resolved.key).toBe("X");
    expect(resolved.cloudId).toBe("mock-cloud");

    const withCloud = await p.resolveScope({ key: "X", cloudId: "override" });
    expect(withCloud.cloudId).toBe("override");
  });

  test("list yields entries with content, skips deleted ones", async () => {
    const p = createMockProvider({
      entries: {
        a: { content: "aa", version: 1 },
        b: { content: "bb", version: 1 },
      },
    });
    await p.delete?.(SCOPE, "a");

    const ids: string[] = [];
    for await (const entry of p.list(SCOPE)) ids.push(entry.id);
    expect(ids).toEqual(["b"]);
    expect(p.calls.list).toBe(1);
    expect(p.calls.delete).toBe(1);
  });

  test("fetch returns content, increments count, throws on unknown", async () => {
    const p = createMockProvider({ entries: { a: { content: "aa", version: 3 } } });
    const result = await p.fetch(SCOPE, "a");
    expect(result.content).toBe("aa");
    expect(result.entry.version).toBe(3);
    expect(p.calls.fetch).toBe(1);
    await expect(p.fetch(SCOPE, "nope")).rejects.toThrow("unknown entry nope");
  });

  test("armFetchFailure injects a one-shot error", async () => {
    const p = createMockProvider({ entries: { a: { content: "aa", version: 1 } } });
    p.armFetchFailure(new Error("network down"));
    await expect(p.fetch(SCOPE, "a")).rejects.toThrow("network down");
    // Subsequent call succeeds.
    const result = await p.fetch(SCOPE, "a");
    expect(result.content).toBe("aa");
  });

  test("push enforces optimistic concurrency", async () => {
    const p = createMockProvider({ entries: { a: { content: "old", version: 1 } } });
    const stale = await p.push?.(SCOPE, "a", "new", 0);
    expect(stale?.ok).toBe(false);
    expect(stale?.error).toContain("version conflict");

    const ok = await p.push?.(SCOPE, "a", "new", 1);
    expect(ok?.ok).toBe(true);
    expect(ok?.newVersion).toBe(2);
    expect(p.state.get("a")?.content).toBe("new");
  });

  test("push to unknown entry returns ok=false", async () => {
    const p = createMockProvider();
    const result = await p.push?.(SCOPE, "missing", "x", 1);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("unknown entry");
  });

  test("armPushFailure throws once", async () => {
    const p = createMockProvider({ entries: { a: { content: "aa", version: 1 } } });
    p.armPushFailure(new Error("auth expired"));
    await expect(p.push?.(SCOPE, "a", "new", 1)).rejects.toThrow("auth expired");
    const ok = await p.push?.(SCOPE, "a", "new", 1);
    expect(ok?.ok).toBe(true);
  });

  test("create adds a new entry with auto-generated id", async () => {
    const p = createMockProvider();
    const entry = await p.create?.(SCOPE, undefined, "Title", "body");
    expect(entry?.id).toMatch(/^mock-/);
    expect(entry?.title).toBe("Title");
    expect(p.state.get(entry?.id ?? "")?.content).toBe("body");
    expect(p.calls.create).toBe(1);
  });

  test("create with parent records parentId", async () => {
    const p = createMockProvider();
    const entry = await p.create?.(SCOPE, "parent-1", "Child", "content");
    expect(p.state.get(entry?.id ?? "")?.parentId).toBe("parent-1");
  });

  test("delete marks entry deleted, future delete of same id throws", async () => {
    const p = createMockProvider({ entries: { a: { content: "aa", version: 1 } } });
    await p.delete?.(SCOPE, "a");
    expect(p.state.get("a")?.deleted).toBe(true);
    // Delete-unknown throws
    await expect(p.delete?.(SCOPE, "ghost")).rejects.toThrow("unknown entry ghost");
  });

  test("remoteEdit bumps version and emits change event", async () => {
    const p = createMockProvider({ entries: { a: { content: "v1", version: 1 } } });
    p.remoteEdit("a", "v2");
    expect(p.state.get("a")?.version).toBe(2);
    expect(p.state.get("a")?.content).toBe("v2");

    const events: string[] = [];
    const changesIter = p.changes?.(SCOPE, "1970-01-01");
    if (changesIter) {
      for await (const ev of changesIter) events.push(`${ev.type}:${ev.entry.id}`);
    }
    expect(events).toContain("updated:a");

    // remoteEdit on missing id throws
    expect(() => p.remoteEdit("nope", "x")).toThrow("unknown entry nope");
  });

  test("snapshot returns a detached copy of state", () => {
    const p = createMockProvider({ entries: { a: { content: "aa", version: 1 } } });
    const snap = p.snapshot();
    expect(snap.a.content).toBe("aa");
    snap.a.content = "mutated";
    expect(p.state.get("a")?.content).toBe("aa");
  });

  test("toPath, frontmatter, validate, toRemote return deterministic values", () => {
    const p = createMockProvider();
    const entry = { id: "x", title: "T", version: 2, lastModified: "", metadata: {} };
    expect(p.toPath(entry, [])).toBe("x.md");
    const fm = p.frontmatter(entry, SCOPE);
    expect(fm.id).toBe("x");
    expect(fm.version).toBe(2);
    expect(p.validate?.("anything")).toEqual({ valid: true, errors: [], warnings: [] });
    expect(p.toRemote?.("**md**")).toBe("**md**");
  });

  test("constructor accepts pre-armed failures", async () => {
    const p = createMockProvider({
      entries: { a: { content: "aa", version: 1 } },
      failNextFetch: new Error("boom"),
      failNextPush: new Error("reject"),
    });
    await expect(p.fetch(SCOPE, "a")).rejects.toThrow("boom");
    await expect(p.push?.(SCOPE, "a", "new", 1)).rejects.toThrow("reject");
  });
});
