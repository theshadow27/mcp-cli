import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "./constants";
import {
  checkForUpdate,
  compareVersions,
  fetchLatestRelease,
  readCheckCache,
  selectAsset,
  writeCheckCache,
} from "./upgrade";

describe("compareVersions", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("newer remote returns positive", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeGreaterThan(0);
  });

  test("older remote returns negative", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.1.0", "1.0.0")).toBeLessThan(0);
  });

  test("strips leading v", () => {
    expect(compareVersions("v1.0.0", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("ignores build metadata", () => {
    expect(compareVersions("1.0.0+12345", "1.0.0+67890")).toBe(0);
    expect(compareVersions("1.0.0+12345", "1.1.0")).toBeGreaterThan(0);
  });

  test("pre-release is less than release (semver)", () => {
    // 1.0.0-dev < 1.0.0 → b > a → positive
    expect(compareVersions("1.0.0-dev", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-dev", "1.1.0")).toBeGreaterThan(0);
    // release > pre-release → negative
    expect(compareVersions("1.0.0", "1.0.0-dev")).toBeLessThan(0);
    // both pre-release with same core → equal
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(0);
  });
});

describe("selectAsset", () => {
  test("darwin arm64", () => {
    expect(selectAsset("darwin", "arm64")).toBe("mcx-darwin-arm64.tar.gz");
  });

  test("darwin x64", () => {
    expect(selectAsset("darwin", "x64")).toBe("mcx-darwin-x64.tar.gz");
  });

  test("linux x64", () => {
    expect(selectAsset("linux", "x64")).toBe("mcx-linux-x64.tar.gz");
  });

  test("linux arm64", () => {
    expect(selectAsset("linux", "arm64")).toBe("mcx-linux-arm64.tar.gz");
  });

  test("unsupported platform returns null", () => {
    expect(selectAsset("win32", "x64")).toBeNull();
    expect(selectAsset("darwin", "ia32")).toBeNull();
  });
});

describe("update check cache", () => {
  let origDir: string;

  beforeEach(() => {
    origDir = options.MCP_CLI_DIR;
    const tmp = join(tmpdir(), `mcp-cli-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    options.MCP_CLI_DIR = tmp;
  });

  afterEach(() => {
    options.MCP_CLI_DIR = origDir;
  });

  test("returns null when no cache exists", () => {
    expect(readCheckCache()).toBeNull();
  });

  test("write then read returns cached value", () => {
    writeCheckCache("2.0.0");
    const cached = readCheckCache();
    expect(cached).not.toBeNull();
    expect(cached?.latest).toBe("2.0.0");
  });

  test("returns null when cache is stale", () => {
    const staleData = JSON.stringify({ checkedAt: Date.now() - 25 * 60 * 60 * 1000, latest: "2.0.0" });
    writeFileSync(join(options.MCP_CLI_DIR, "update-check.json"), staleData, "utf-8");
    expect(readCheckCache()).toBeNull();
  });

  test("returns cached when within TTL", () => {
    const freshData = JSON.stringify({ checkedAt: Date.now() - 1000, latest: "2.0.0" });
    writeFileSync(join(options.MCP_CLI_DIR, "update-check.json"), freshData, "utf-8");
    const cached = readCheckCache();
    expect(cached).not.toBeNull();
    expect(cached?.latest).toBe("2.0.0");
  });
});

function mockFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return ((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof globalThis.fetch;
}

const RELEASE_BODY = {
  tag_name: "v2.0.0",
  assets: [
    { name: "mcx-darwin-arm64.tar.gz", browser_download_url: "https://example.com/arm64", size: 1024 },
    { name: "mcx-linux-x64.tar.gz", browser_download_url: "https://example.com/linux", size: 2048 },
  ],
};

describe("fetchLatestRelease", () => {
  test("parses GitHub release response", async () => {
    const release = await fetchLatestRelease({ fetch: mockFetch(RELEASE_BODY) });
    expect(release.tag).toBe("v2.0.0");
    expect(release.version).toBe("2.0.0");
    expect(release.assets).toHaveLength(2);
    expect(release.assets[0].name).toBe("mcx-darwin-arm64.tar.gz");
    expect(release.assets[0].url).toBe("https://example.com/arm64");
  });

  test("includes auth header when ghToken provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const spy = ((_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Promise.resolve(new Response(JSON.stringify(RELEASE_BODY), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    await fetchLatestRelease({ fetch: spy, ghToken: "test-token" });
    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
  });

  test("throws on non-OK response", async () => {
    const failFetch = mockFetch({ message: "rate limited" }, 429);
    await expect(fetchLatestRelease({ fetch: failFetch, ghToken: "skip-fallback" })).rejects.toThrow(
      "GitHub API returned 429",
    );
  });
});

describe("checkForUpdate", () => {
  let origDir: string;

  beforeEach(() => {
    origDir = options.MCP_CLI_DIR;
    const tmp = join(tmpdir(), `mcp-cli-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    options.MCP_CLI_DIR = tmp;
  });

  afterEach(() => {
    options.MCP_CLI_DIR = origDir;
  });

  test("detects update available", async () => {
    const result = await checkForUpdate("1.0.0", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe("2.0.0");
    expect(result.current).toBe("1.0.0");
  });

  test("detects already up to date", async () => {
    const result = await checkForUpdate("2.0.0", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.updateAvailable).toBe(false);
  });

  test("uses cache when fresh", async () => {
    writeCheckCache("3.0.0");
    let fetchCalled = false;
    const spy = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(JSON.stringify(RELEASE_BODY), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const result = await checkForUpdate("1.0.0", { fetch: spy });
    expect(fetchCalled).toBe(false);
    expect(result.latest).toBe("3.0.0");
    expect(result.updateAvailable).toBe(true);
  });

  test("skips cache when skipCache is true", async () => {
    writeCheckCache("3.0.0");
    const result = await checkForUpdate("1.0.0", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.latest).toBe("2.0.0"); // From fetch, not cache
  });

  test("writes cache after fetch", async () => {
    await checkForUpdate("1.0.0", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    const cached = readCheckCache();
    expect(cached?.latest).toBe("2.0.0");
  });
});
