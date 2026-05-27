import { describe, expect, test } from "bun:test";
import { createBrowserHandlers } from "./browser-handlers";
import type { BrowserEngine, BrowserEvents, SiteSpec, StartSiteResult } from "./browser/engine";

// ── Fake BrowserEngine ──

interface FakeEngineControls {
  /** Resolves when engine.start() has been called — await this before resolveStart(). */
  startCalled: Promise<void>;
  /** Resolve the pending start() call. */
  resolveStart: (results?: StartSiteResult[]) => void;
  /** Reject the pending start() call. */
  rejectStart: (err: Error) => void;
  /** Control isRunning() return value. */
  setRunning: (v: boolean) => void;
  /** Number of times isRunning() was called. */
  isRunningCallCount: () => number;
  /** Number of times wiggle() was called. */
  wiggleCallCount: () => number;
}

function makePausableEngine(): { engine: BrowserEngine; controls: FakeEngineControls } {
  let running = false;
  let isRunningCount = 0;
  let wiggleCount = 0;
  let startResolve!: (results: StartSiteResult[]) => void;
  let startReject!: (err: Error) => void;
  let notifyStartCalled!: () => void;
  const startCalled = new Promise<void>((r) => {
    notifyStartCalled = r;
  });

  const engine: BrowserEngine = {
    start(_sites: SiteSpec[], _events: BrowserEvents): Promise<StartSiteResult[]> {
      if (running) {
        // Idempotent — already running; mirrors the real engine's behaviour.
        return Promise.resolve([{ site: "test-site", url: "https://example.com", status: "already-running" }]);
      }
      notifyStartCalled();
      return new Promise<StartSiteResult[]>((resolve, reject) => {
        startResolve = resolve;
        startReject = reject;
      });
    },
    stop(): Promise<void> {
      running = false;
      return Promise.resolve();
    },
    isRunning(): boolean {
      isRunningCount++;
      return running;
    },
    getSiteNames(): string[] {
      return ["test-site"];
    },
    wiggle(_site?: string): Promise<string[]> {
      wiggleCount++;
      return Promise.resolve([]);
    },
    evalInPage(_code: string, _site?: string): Promise<unknown> {
      return Promise.resolve(null);
    },
    fetchInPage(
      _url: string,
      _method: string,
      _headers: Record<string, string>,
      _body: string | undefined,
      _site?: string,
    ) {
      return Promise.resolve({ status: 200, headers: {}, body: {} });
    },
    coldStart(_site?: string) {
      return Promise.resolve({ cleared: [], reloaded: false });
    },
    getUrl(_site?: string): Promise<string> {
      return Promise.resolve("https://example.com");
    },
    getTitle(_site?: string): Promise<string> {
      return Promise.resolve("Test");
    },
    getHtml(_site?: string): Promise<string> {
      return Promise.resolve("<html/>");
    },
  };

  const controls: FakeEngineControls = {
    startCalled,
    resolveStart(results = [{ site: "test-site", url: "https://example.com", status: "navigated" }]) {
      running = true;
      startResolve(results as StartSiteResult[]);
    },
    rejectStart(err: Error) {
      startReject(err);
    },
    setRunning(v: boolean) {
      running = v;
    },
    isRunningCallCount: () => isRunningCount,
    wiggleCallCount: () => wiggleCount,
  };

  return { engine, controls };
}

// ── Minimal fake sniffer ──

function makeFakeSniffer() {
  return {
    configureSite(_site: string, _mode: string, _filters?: unknown): void {},
    asEvents(): BrowserEvents {
      return {};
    },
  };
}

// ── Minimal fake site config ──

function fakeSite(name = "test-site") {
  return {
    name,
    enabled: true as const,
    url: "https://example.com",
  };
}

function fakeSpec(name = "test-site"): SiteSpec {
  return { name, url: "https://example.com", profileDir: "/tmp/fake-profile" };
}

// ── Tests ──

describe("createBrowserHandlers — handler-level race coverage", () => {
  test("observer (snapshotBrowser) queues behind handleBrowserStart and sees engine only after start() resolves", async () => {
    const { engine, controls } = makePausableEngine();

    const handlers = createBrowserHandlers({
      loadBrowserFn: async () => engine,
      getSiteFn: (name) => (name === "test-site" ? fakeSite() : null),
      listSitesFn: () => [fakeSite()],
      siteSpecForFn: () => fakeSpec(),
      sniffer: makeFakeSniffer(),
    });

    // Kick off handleBrowserStart — will pause inside the lock waiting on eng.start().
    const startPromise = handlers.handleBrowserStart({ sites: ["test-site"] });

    // Wait until engine.start() is actually called (lock is held, start is in-flight).
    await controls.startCalled;

    // snapshotBrowser queues behind the lock — should not resolve yet.
    const observerPromise = handlers.snapshotBrowser();

    // Confirm the observer has not yet settled (the lock is still held by start).
    let observerDone = false;
    observerPromise.then(() => {
      observerDone = true;
    });
    await Promise.resolve();
    expect(observerDone).toBe(false);

    // Resolve the engine's start() — handleBrowserStart finishes, lock released.
    controls.resolveStart();
    await startPromise;

    // Observer runs now (lock released) and sees the engine.
    const observed = await observerPromise;
    expect(observed).toBe(engine);
  });

  test("handleWiggle queues behind handleBrowserStart and receives the started engine", async () => {
    const { engine, controls } = makePausableEngine();

    const handlers = createBrowserHandlers({
      loadBrowserFn: async () => engine,
      getSiteFn: (name) => (name === "test-site" ? fakeSite() : null),
      listSitesFn: () => [fakeSite()],
      siteSpecForFn: () => fakeSpec(),
      sniffer: makeFakeSniffer(),
    });

    const startPromise = handlers.handleBrowserStart({ sites: ["test-site"] });
    await controls.startCalled;

    // handleWiggle calls snapshotBrowser internally — it will queue behind the lock.
    const wigglePromise = handlers.handleWiggle({});

    controls.resolveStart();
    await startPromise;

    const result = await wigglePromise;
    // wiggle should succeed (engine is now set and isRunning() is true).
    expect(result.isError).not.toBe(true);
    expect(controls.wiggleCallCount()).toBe(1);
  });

  test("resetIfBrowserDied inside observer clears a dead browser after start completes", async () => {
    const { engine, controls } = makePausableEngine();

    const handlers = createBrowserHandlers({
      loadBrowserFn: async () => engine,
      getSiteFn: (name) => (name === "test-site" ? fakeSite() : null),
      listSitesFn: () => [fakeSite()],
      siteSpecForFn: () => fakeSpec(),
      sniffer: makeFakeSniffer(),
    });

    // Start the browser successfully.
    const startPromise = handlers.handleBrowserStart({ sites: ["test-site"] });
    await controls.startCalled;
    controls.resolveStart();
    await startPromise;

    // Engine is running — snapshotBrowser should return it.
    const alive = await handlers.snapshotBrowser();
    expect(alive).toBe(engine);

    // Simulate the engine dying (Chrome closed externally).
    controls.setRunning(false);

    // snapshotBrowser calls resetIfBrowserDied inside the lock.
    // isRunning() = false → browser should be cleared → null returned.
    const dead = await handlers.snapshotBrowser();
    expect(dead).toBeNull();
    expect(controls.isRunningCallCount()).toBeGreaterThan(0);
  });

  test("handleWiggle returns 'session was dropped' error after engine dies", async () => {
    const { engine, controls } = makePausableEngine();

    const handlers = createBrowserHandlers({
      loadBrowserFn: async () => engine,
      getSiteFn: (name) => (name === "test-site" ? fakeSite() : null),
      listSitesFn: () => [fakeSite()],
      siteSpecForFn: () => fakeSpec(),
      sniffer: makeFakeSniffer(),
    });

    // Start then kill the engine.
    const startPromise = handlers.handleBrowserStart({ sites: ["test-site"] });
    await controls.startCalled;
    controls.resolveStart();
    await startPromise;
    controls.setRunning(false);

    const result = await handlers.handleWiggle({});
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/session was dropped/);
  });

  test("second concurrent handleBrowserStart sees already-running engine without double-start", async () => {
    const { engine, controls } = makePausableEngine();
    let startCallCount = 0;

    const handlers = createBrowserHandlers({
      loadBrowserFn: async () => {
        startCallCount++;
        return engine;
      },
      getSiteFn: (name) => (name === "test-site" ? fakeSite() : null),
      listSitesFn: () => [fakeSite()],
      siteSpecForFn: () => fakeSpec(),
      sniffer: makeFakeSniffer(),
    });

    // First start — paused.
    const first = handlers.handleBrowserStart({ sites: ["test-site"] });
    await controls.startCalled;

    // Second start queues behind the first.
    const second = handlers.handleBrowserStart({ sites: ["test-site"] });

    controls.resolveStart();
    await first;

    // Second call runs inside the lock now: resetIfBrowserDied() sees browser is
    // running → loadBrowserInternal returns existing engine → start() not called again.
    const secondResult = await second;
    expect(secondResult.isError).not.toBe(true);

    // loadBrowserFn was called only once (second call took the early-return path).
    expect(startCallCount).toBe(1);
  });
});
