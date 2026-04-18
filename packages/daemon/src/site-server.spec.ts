import { afterEach, describe, expect, mock, test } from "bun:test";
import { SITE_SERVER_NAME, silentLogger } from "@mcp-cli/core";
import { SiteServer, buildSiteToolCache, isWorkerEvent } from "./site-server";
import { SITE_TOOLS } from "./site/tools";

describe("isWorkerEvent (site)", () => {
  test("matches known event types", () => {
    expect(isWorkerEvent({ type: "ready" })).toBe(true);
    expect(isWorkerEvent({ type: "error", message: "x" })).toBe(true);
  });

  test("rejects unknown types and non-objects", () => {
    expect(isWorkerEvent({ type: "db:upsert" })).toBe(false);
    expect(isWorkerEvent({})).toBe(false);
    expect(isWorkerEvent(null)).toBe(false);
    expect(isWorkerEvent("ready")).toBe(false);
  });
});

describe("buildSiteToolCache", () => {
  test("returns a ToolInfo for every defined tool", () => {
    const cache = buildSiteToolCache();
    expect(cache.size).toBe(SITE_TOOLS.length);
    for (const def of SITE_TOOLS) {
      const info = cache.get(def.name);
      expect(info).toBeDefined();
      expect(info?.server).toBe(SITE_SERVER_NAME);
      expect(info?.description).toBe(def.description);
      expect(info?.signature).toBeTruthy();
    }
  });
});

describe("SITE_SERVER_NAME", () => {
  test("is _site", () => {
    expect(SITE_SERVER_NAME).toBe("_site");
  });
});

/**
 * Fake Worker that responds to init with ready, and ignores everything else.
 * Lets us exercise SiteServer's handshake + failure paths without spawning a real worker.
 */
function makeFakeWorker(behavior: { replyReady?: boolean; replyErrorMessage?: string } = { replyReady: true }): Worker {
  const listeners = new Map<string, ((event: MessageEvent | ErrorEvent | Event) => void) | null>();
  const worker = {
    postMessage: mock((msg: unknown) => {
      const m = msg as { type?: string } | undefined;
      if (m?.type === "init") {
        queueMicrotask(() => {
          const onmessage = listeners.get("message");
          if (!onmessage) return;
          if (behavior.replyErrorMessage) {
            onmessage({ data: { type: "error", message: behavior.replyErrorMessage } } as MessageEvent);
          } else if (behavior.replyReady) {
            onmessage({ data: { type: "ready" } } as MessageEvent);
          }
        });
      }
    }),
    terminate: mock(() => {}),
    get onmessage() {
      return listeners.get("message") ?? null;
    },
    set onmessage(fn) {
      listeners.set("message", fn);
    },
    get onerror() {
      return listeners.get("error") ?? null;
    },
    set onerror(fn) {
      listeners.set("error", fn);
    },
  };
  return worker as unknown as Worker;
}

describe("SiteServer", () => {
  let server: SiteServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("rejects on worker error message", async () => {
    const workerFactory = (_path: string): Worker => makeFakeWorker({ replyErrorMessage: "boom" });
    server = new SiteServer(undefined, undefined, workerFactory, silentLogger, 500);
    await expect(server.start()).rejects.toThrow(/boom/);
  });

  test("rejects on handshake timeout when no ready arrives", async () => {
    const workerFactory = (_path: string): Worker => makeFakeWorker({ replyReady: false });
    server = new SiteServer(undefined, undefined, workerFactory, silentLogger, 250);
    await expect(server.start()).rejects.toThrow(/timeout/);
  });
});
