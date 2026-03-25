import { afterEach, describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import type { RegistryEntry } from "./registry-client.js";
import { type UseRegistryDataDeps, type UseRegistryDataResult, useRegistryData } from "./use-registry-data.js";

/* ---------- helpers ---------- */

function fakeEntry(name: string): RegistryEntry {
  return {
    server: {
      name,
      title: name,
      description: `desc-${name}`,
      version: "1.0.0",
    },
    _meta: {
      "com.anthropic.api/mcp-registry": {
        slug: name,
        displayName: name,
        oneLiner: name,
        isAuthless: true,
      },
    },
  };
}

function fakeResponse(names: string[]) {
  return { servers: names.map(fakeEntry), metadata: { count: names.length } };
}

/** Creates a promise that can be resolved/rejected externally. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(ms = 10) {
  await Bun.sleep(ms);
}

interface HookState extends UseRegistryDataResult {}

const Harness: FC<{ deps: UseRegistryDataDeps; stateRef: { current: HookState } }> = ({ deps, stateRef }) => {
  const result = useRegistryData(deps);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

/* ---------- tests ---------- */

describe("useRegistryData", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(deps: UseRegistryDataDeps) {
    const stateRef: { current: HookState } = {
      current: {
        entries: [],
        loading: false,
        error: null,
        search: () => {},
        loadPopular: () => {},
      },
    };
    const instance = render(React.createElement(Harness, { deps, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  describe("search()", () => {
    it("fetches results after debounce delay", async () => {
      const d = deferred<ReturnType<typeof fakeResponse>>();
      const searchFn = async (query: string, limit?: number) => {
        expect(query).toBe("test-query");
        expect(limit).toBe(50);
        return d.promise;
      };
      const deps: UseRegistryDataDeps = {
        searchRegistry: searchFn,
        listRegistry: async () => fakeResponse([]),
      };

      const { stateRef } = mount(deps);
      await flush();

      // Trigger search
      stateRef.current.search("test-query");
      await flush();

      // Loading should be true immediately
      expect(stateRef.current.loading).toBe(true);
      expect(stateRef.current.entries).toEqual([]);

      // Wait for debounce (300ms) + buffer
      await flush(350);

      // Resolve the fetch
      d.resolve(fakeResponse(["server-a", "server-b"]));
      await flush();

      expect(stateRef.current.loading).toBe(false);
      expect(stateRef.current.entries).toHaveLength(2);
      expect(stateRef.current.entries[0].server.name).toBe("server-a");
      expect(stateRef.current.error).toBeNull();
    });

    it("sets error on fetch failure", async () => {
      const d = deferred<ReturnType<typeof fakeResponse>>();
      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => d.promise,
        listRegistry: async () => fakeResponse([]),
      };

      const { stateRef } = mount(deps);
      await flush();

      stateRef.current.search("fail-query");
      await flush(350);

      d.reject(new Error("network down"));
      await flush();

      expect(stateRef.current.loading).toBe(false);
      expect(stateRef.current.error).toBe("network down");
      expect(stateRef.current.entries).toEqual([]);
    });

    it("stringifies non-Error rejections", async () => {
      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => {
          throw "string-error";
        },
        listRegistry: async () => fakeResponse([]),
      };

      const { stateRef } = mount(deps);
      await flush();

      stateRef.current.search("q");
      await flush(350);
      await flush();

      expect(stateRef.current.error).toBe("string-error");
    });
  });

  describe("loadPopular()", () => {
    it("fetches popular servers immediately (no debounce)", async () => {
      const d = deferred<ReturnType<typeof fakeResponse>>();
      let called = false;
      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => fakeResponse([]),
        listRegistry: async (limit?: number) => {
          called = true;
          expect(limit).toBe(50);
          return d.promise;
        },
      };

      const { stateRef } = mount(deps);
      await flush();

      stateRef.current.loadPopular();
      await flush();

      // Should have called listRegistry immediately (not debounced)
      expect(called).toBe(true);
      expect(stateRef.current.loading).toBe(true);

      d.resolve(fakeResponse(["popular-1", "popular-2", "popular-3"]));
      await flush();

      expect(stateRef.current.loading).toBe(false);
      expect(stateRef.current.entries).toHaveLength(3);
      expect(stateRef.current.entries[0].server.name).toBe("popular-1");
    });

    it("sets error on fetch failure", async () => {
      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => fakeResponse([]),
        listRegistry: async () => {
          throw new Error("list failed");
        },
      };

      const { stateRef } = mount(deps);
      await flush();

      stateRef.current.loadPopular();
      await flush();

      expect(stateRef.current.loading).toBe(false);
      expect(stateRef.current.error).toBe("list failed");
    });
  });

  describe("abort-on-stale", () => {
    it("ignores stale search results when a newer search is issued", async () => {
      const d1 = deferred<ReturnType<typeof fakeResponse>>();
      const d2 = deferred<ReturnType<typeof fakeResponse>>();
      let callCount = 0;

      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => {
          callCount++;
          return callCount === 1 ? d1.promise : d2.promise;
        },
        listRegistry: async () => fakeResponse([]),
      };

      const { stateRef } = mount(deps);
      await flush();

      // Issue first search, wait for debounce to fire
      stateRef.current.search("first");
      await flush(350);

      // Issue second search (this bumps abortRef, invalidating first)
      stateRef.current.search("second");
      await flush(350);

      // Resolve first (stale) — should be ignored
      d1.resolve(fakeResponse(["stale"]));
      await flush();

      expect(stateRef.current.entries).toEqual([]);
      expect(stateRef.current.loading).toBe(true);

      // Resolve second (current)
      d2.resolve(fakeResponse(["fresh"]));
      await flush();

      expect(stateRef.current.entries).toHaveLength(1);
      expect(stateRef.current.entries[0].server.name).toBe("fresh");
      expect(stateRef.current.loading).toBe(false);
    });

    it("ignores stale loadPopular when search is called after", async () => {
      const dList = deferred<ReturnType<typeof fakeResponse>>();
      const dSearch = deferred<ReturnType<typeof fakeResponse>>();

      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => dSearch.promise,
        listRegistry: async () => dList.promise,
      };

      const { stateRef } = mount(deps);
      await flush();

      // Load popular first
      stateRef.current.loadPopular();
      await flush();

      // Then search (bumps abortRef, cancels pending debounce)
      stateRef.current.search("q");
      await flush(350);

      // Resolve the loadPopular (stale)
      dList.resolve(fakeResponse(["popular-stale"]));
      await flush();

      // Should be ignored
      expect(stateRef.current.entries).toEqual([]);

      // Resolve search (current)
      dSearch.resolve(fakeResponse(["search-result"]));
      await flush();

      expect(stateRef.current.entries).toHaveLength(1);
      expect(stateRef.current.entries[0].server.name).toBe("search-result");
    });
  });

  describe("debounce cancellation", () => {
    it("only fires one fetch for rapid consecutive searches", async () => {
      let fetchCount = 0;
      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => {
          fetchCount++;
          return fakeResponse(["result"]);
        },
        listRegistry: async () => fakeResponse([]),
      };

      const { stateRef } = mount(deps);
      await flush();

      // Rapid-fire 5 searches within debounce window
      stateRef.current.search("a");
      await flush(50);
      stateRef.current.search("ab");
      await flush(50);
      stateRef.current.search("abc");
      await flush(50);
      stateRef.current.search("abcd");
      await flush(50);
      stateRef.current.search("abcde");

      // Wait for debounce to fire
      await flush(350);
      await flush();

      // Only the last search should have triggered a fetch
      expect(fetchCount).toBe(1);
      expect(stateRef.current.entries).toHaveLength(1);
      expect(stateRef.current.loading).toBe(false);
    });

    it("loadPopular cancels pending debounced search", async () => {
      let searchCalled = false;
      const dList = deferred<ReturnType<typeof fakeResponse>>();

      const deps: UseRegistryDataDeps = {
        searchRegistry: async () => {
          searchCalled = true;
          return fakeResponse(["search"]);
        },
        listRegistry: async () => dList.promise,
      };

      const { stateRef } = mount(deps);
      await flush();

      // Start a search (debounced — not fired yet)
      stateRef.current.search("q");
      await flush(100); // Less than 300ms debounce

      // loadPopular should cancel the pending search debounce
      stateRef.current.loadPopular();

      // Wait past the debounce window
      await flush(350);

      // The search fetch should never have fired
      expect(searchCalled).toBe(false);

      // Resolve loadPopular
      dList.resolve(fakeResponse(["popular"]));
      await flush();

      expect(stateRef.current.entries).toHaveLength(1);
      expect(stateRef.current.entries[0].server.name).toBe("popular");
    });
  });
});
