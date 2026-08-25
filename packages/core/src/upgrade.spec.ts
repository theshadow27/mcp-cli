import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "./constants";
import {
  type ExecutableIdentity,
  type InstallMarker,
  type ProvenanceInput,
  checkForUpdate,
  compareVersions,
  currentExecutable,
  fetchLatestRelease,
  installMarkerPath,
  readCheckCache,
  readInstallMarker,
  resolveProvenance,
  selectAsset,
  writeCheckCache,
  writeInstallMarker,
} from "./upgrade";

describe("compareVersions", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("a > b returns positive", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
  });

  test("a < b returns negative", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
  });

  test("strips leading v", () => {
    expect(compareVersions("v1.0.0", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("ignores build metadata", () => {
    expect(compareVersions("1.0.0+12345", "1.0.0+67890")).toBe(0);
    expect(compareVersions("1.1.0", "1.0.0+12345")).toBeGreaterThan(0);
  });

  test("pre-release is less than release (semver)", () => {
    // 1.0.0-dev < 1.0.0 → a < b → negative
    expect(compareVersions("1.0.0-dev", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-dev", "1.1.0")).toBeLessThan(0);
    // release > pre-release → positive
    expect(compareVersions("1.0.0", "1.0.0-dev")).toBeGreaterThan(0);
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

  test("an unmarked +epoch build at the release version reports unknown, never a dev build (#3260)", async () => {
    // Regression for #3260: `2.0.0+1787442054` is what an official release
    // artifact's BUILD_VERSION looks like — scripts/build.ts stamps +epoch on
    // every compiled binary, release CI included. With no install marker we
    // cannot tell it from a local build of the same version, and "unknown" is
    // the only true answer; the old code asserted "dev build" here.
    const result = await checkForUpdate("2.0.0+1787442054", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.updateAvailable).toBe(false);
    expect(result.provenance).toBe("unknown");
  });

  test("reads provenance from an install marker covering the running executable (#3260)", async () => {
    // End-to-end over real disk: marker + statSync + realpath, no injection.
    writeInstallMarker("2.0.0", "install.sh", [process.execPath]);
    const result = await checkForUpdate("2.0.0+1787442054", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.updateAvailable).toBe(false);
    expect(result.provenance).toBe("release");
  });

  test("a build behind the latest release still reports a real update", async () => {
    const result = await checkForUpdate("1.0.0+1787442054", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.updateAvailable).toBe(true);
  });

  test("a -dev prerelease build reports both an available update and dev provenance", async () => {
    const result = await checkForUpdate("2.0.0-dev", { fetch: mockFetch(RELEASE_BODY), skipCache: true });
    expect(result.updateAvailable).toBe(true);
    expect(result.provenance).toBe("dev");
  });

  test("provenance is resolved against the cached latest version too", async () => {
    writeCheckCache("3.0.0");
    const result = await checkForUpdate("2.0.0+1787442054", { fetch: mockFetch(RELEASE_BODY) });
    expect(result.latest).toBe("3.0.0");
    expect(result.provenance).toBe("unknown");
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

describe("resolveProvenance", () => {
  const INSTALLED = "a".repeat(64);
  const OTHER_BYTES = "b".repeat(64);
  const exe: ExecutableIdentity = {
    paths: ["/home/u/.mcp-cli/bin/mcx"],
    size: 1000,
    sha256: () => INSTALLED,
  };
  const marker: InstallMarker = {
    version: "2.0.0",
    installedAt: 1787442054,
    source: "install.sh",
    binaries: [{ path: "/home/u/.mcp-cli/bin/mcx", size: 1000, sha256: INSTALLED }],
  };
  const input = (over: Partial<ProvenanceInput> = {}): ProvenanceInput => ({
    current: "2.0.0+1787442054",
    latest: "2.0.0",
    commit: "abc123def456",
    marker: null,
    exe: null,
    ...over,
  });

  test("a marker covering the running executable proves a release install", () => {
    expect(resolveProvenance(input({ marker, exe }))).toBe("release");
  });

  test("an unmarked +epoch binary at the release version is unknown, not dev (#3260)", () => {
    // The whole point of the issue: every release artifact carries +epoch, so
    // this state must not be reported as a dev build.
    expect(resolveProvenance(input())).toBe("unknown");
  });

  test("a marker for a different version does not vouch for this binary", () => {
    expect(resolveProvenance(input({ current: "2.1.0+1787442054", marker, exe, latest: "2.1.0" }))).toBe("unknown");
  });

  test("a marker for a different path does not vouch for this binary", () => {
    const elsewhere = { ...exe, paths: ["/usr/local/bin/mcx"] };
    expect(resolveProvenance(input({ marker, exe: elsewhere }))).toBe("unknown");
  });

  test("a size mismatch means the installed file was overwritten since", () => {
    // e.g. a `bun build` output copied over ~/.mcp-cli/bin/mcx — the marker
    // attests to installed bytes, not merely to a path once written.
    expect(resolveProvenance(input({ marker, exe: { ...exe, size: 2000 } }))).toBe("unknown");
  });

  test("a same-size overwrite of the marked path is not a release install (#3260)", () => {
    // The repair for this PR's qa:fail. `markerCoversExecutable` used to prove
    // identity by path + byte size alone, so overwriting ~/.mcp-cli/bin/mcx
    // with a *different* binary of the same length — entirely plausible, since
    // __BUILD_EPOCH__/__BUILD_COMMIT__ are fixed-width embedded strings, so two
    // builds of one version routinely match in length — was reported as a
    // proven "release". A confident falsehood is the exact failure #3260 was
    // filed about; the marker now records a content hash and this reads back
    // as "unknown".
    expect(resolveProvenance(input({ marker, exe: { ...exe, sha256: () => OTHER_BYTES } }))).toBe("unknown");
  });

  test("a dirty-tree rebuild copied over the marked path reports dev, not release (#3260)", () => {
    // The same substitution with BUILD_COMMIT also saying `-dirty`. Under the
    // size-only check the marker outranked the dirty stamp and returned
    // "release" — a disagreement between two provenance sources resolved in
    // favour of the weaker proof. The hash no longer matches, so the dirty
    // stamp is reached and wins.
    const overwritten = { ...exe, sha256: () => OTHER_BYTES };
    expect(resolveProvenance(input({ marker, exe: overwritten, commit: "deadbeefcafe-dirty" }))).toBe("dev");
  });

  test("an executable whose bytes cannot be hashed is unknown, never release", () => {
    // No size-only fallback: unreadable contents means unproven, and unproven
    // means "unknown".
    expect(resolveProvenance(input({ marker, exe: { ...exe, sha256: () => null } }))).toBe("unknown");
  });

  test("does not hash the executable when path and size already rule the marker out", () => {
    // The hash is ~80MB of IO on a real binary; the cheap fields exist so that
    // `mcx upgrade --check` on an unmarked build never pays for it.
    let hashed = 0;
    const counted = {
      ...exe,
      size: 2000,
      sha256: () => {
        hashed++;
        return INSTALLED;
      },
    };
    expect(resolveProvenance(input({ marker, exe: counted }))).toBe("unknown");
    expect(hashed).toBe(0);
  });

  test("matches an executable reached through a symlinked path", () => {
    const viaSymlink = { ...exe, paths: ["/home/link/bin/mcx", "/home/u/.mcp-cli/bin/mcx"] };
    expect(resolveProvenance(input({ marker, exe: viaSymlink }))).toBe("release");
  });

  test("a dirty-tree build commit is provably not a release artifact", () => {
    expect(resolveProvenance(input({ commit: "abc123def456-dirty" }))).toBe("dev");
  });

  test("an unverifiable dirty probe is treated as dev, not assumed clean", () => {
    expect(resolveProvenance(input({ commit: "abc123def456-unknown" }))).toBe("dev");
  });

  test("a -dev prerelease build is a dev build", () => {
    expect(resolveProvenance(input({ current: "2.0.0-dev", commit: null }))).toBe("dev");
  });

  test("a version ahead of every release cannot be an installed release", () => {
    expect(resolveProvenance(input({ current: "2.1.0+1787442054", latest: "2.0.0" }))).toBe("dev");
  });

  test("a marker outranks a dirty commit stamp for the exact installed bytes", () => {
    // Sound only because the marker is a content hash: these bytes came out of
    // a release, whatever the local tree looks like now. A rebuild of the same
    // version from that dirty tree produces different bytes and loses the
    // match — see the same-size-overwrite test above.
    expect(resolveProvenance(input({ marker, exe, commit: "abc123def456-dirty" }))).toBe("release");
  });

  test("an unstamped binary (no BUILD_COMMIT) is unknown, not dev", () => {
    expect(resolveProvenance(input({ commit: null }))).toBe("unknown");
  });
});

describe("install marker", () => {
  let origDir: string;

  beforeEach(() => {
    origDir = options.MCP_CLI_DIR;
    const tmp = join(tmpdir(), `mcp-cli-marker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    options.MCP_CLI_DIR = tmp;
  });

  afterEach(() => {
    options.MCP_CLI_DIR = origDir;
  });

  const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
  /** Valid marker envelope, so element-shape tests vary only `binaries`. */
  const MARKER_STUB = { version: "2.0.0", installedAt: 1787442054, source: "install.sh" };

  test("round-trips version, source, stat'd sizes and content hashes", () => {
    const binPath = join(options.MCP_CLI_DIR, "mcx-fake");
    writeFileSync(binPath, "0123456789", "utf-8");

    writeInstallMarker("v2.0.0", "mcx-upgrade", [binPath]);

    const marker = readInstallMarker();
    expect(marker?.version).toBe("2.0.0"); // leading v stripped
    expect(marker?.source).toBe("mcx-upgrade");
    expect(marker?.binaries).toEqual([{ path: binPath, size: 10, sha256: sha256("0123456789") }]);
  });

  test("a same-size overwrite of an installed binary reads back as unknown (#3260)", () => {
    // The qa:fail repro for this PR, end-to-end over real files: mark a
    // binary, replace it with different bytes of identical length, and ask
    // where the running binary came from. Size and path still match — only
    // the hash catches it.
    const binPath = join(options.MCP_CLI_DIR, "mcx-fake");
    writeFileSync(binPath, "0123456789", "utf-8");
    writeInstallMarker("2.0.0", "install.sh", [binPath]);

    writeFileSync(binPath, "9876543210", "utf-8"); // same 10 bytes' worth, different content
    const marker = readInstallMarker();
    const exe = currentExecutable(binPath);
    expect(exe?.size).toBe(marker?.binaries[0]?.size); // the old check's whole basis
    expect(
      resolveProvenance({
        current: "2.0.0+1787442054",
        latest: "2.0.0",
        commit: "deadbeefcafe-dirty",
        marker,
        exe,
      }),
    ).toBe("dev");
  });

  test("an untouched installed binary still proves a release install end to end", () => {
    const binPath = join(options.MCP_CLI_DIR, "mcx-fake");
    writeFileSync(binPath, "0123456789", "utf-8");
    writeInstallMarker("2.0.0", "install.sh", [binPath]);

    expect(
      resolveProvenance({
        current: "2.0.0+1787442054",
        latest: "2.0.0",
        commit: "deadbeefcafe",
        marker: readInstallMarker(),
        exe: currentExecutable(binPath),
      }),
    ).toBe("release");
  });

  test("skips paths that don't exist rather than failing the install", () => {
    writeInstallMarker("2.0.0", "mcx-upgrade", [join(options.MCP_CLI_DIR, "absent")]);
    expect(readInstallMarker()?.binaries).toEqual([]);
  });

  test("replaces an existing marker atomically, leaving no temp file behind", () => {
    const binPath = join(options.MCP_CLI_DIR, "mcx-fake");
    writeFileSync(binPath, "0123456789", "utf-8");
    writeInstallMarker("1.0.0", "install.sh", [binPath]);
    writeInstallMarker("2.0.0", "mcx-upgrade", [binPath]);

    expect(readInstallMarker()?.version).toBe("2.0.0");
    expect(readdirSync(join(installMarkerPath(), ".."))).toEqual([".installed"]);
  });

  test("returns null when no marker is present", () => {
    expect(readInstallMarker()).toBeNull();
  });

  test("returns null on a corrupt marker instead of throwing", () => {
    const path = installMarkerPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json", "utf-8");
    expect(readInstallMarker()).toBeNull();
  });

  test("returns null on a well-formed but wrong-shaped marker", () => {
    const path = installMarkerPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2 }), "utf-8");
    expect(readInstallMarker()).toBeNull();
  });

  test("drops malformed binary entries instead of throwing on them", () => {
    // A hand-edited or truncated `binaries` element used to reach the matcher
    // and crash `mcx upgrade` outright ("null is not an object"). Every
    // undecidable marker has to land in `unknown`, including this one.
    const path = installMarkerPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const good = { path: "/home/u/.mcp-cli/bin/mcx", size: 10, sha256: sha256("0123456789") };
    writeFileSync(path, JSON.stringify({ ...MARKER_STUB, binaries: [null, "nope", { path: 1 }, good] }), "utf-8");
    expect(readInstallMarker()?.binaries).toEqual([good]);
  });

  test("drops entries from a marker written before hashes were recorded", () => {
    // An entry with no `sha256` proves nothing about the bytes on disk today.
    // Upgrading from a pre-hash marker degrades to `unknown`, not `release`.
    const path = installMarkerPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const legacy = { ...MARKER_STUB, binaries: [{ path: "/home/u/.mcp-cli/bin/mcx", size: 1000 }] };
    writeFileSync(path, JSON.stringify(legacy), "utf-8");

    const marker = readInstallMarker();
    expect(marker?.binaries).toEqual([]);
    const exe: ExecutableIdentity = { paths: ["/home/u/.mcp-cli/bin/mcx"], size: 1000, sha256: () => "deadbeef" };
    expect(resolveProvenance({ current: "2.0.0+1787442054", latest: "2.0.0", commit: "abc123", marker, exe })).toBe(
      "unknown",
    );
  });
});

describe("currentExecutable", () => {
  test("reports the running executable's size", () => {
    const exe = currentExecutable();
    expect(exe?.paths).toContain(process.execPath);
    expect(exe?.size).toBeGreaterThan(0);
  });

  test("hashes the file's contents on demand", () => {
    const path = join(tmpdir(), `mcp-cli-exe-hash-${process.pid}`);
    writeFileSync(path, "0123456789", "utf-8");
    try {
      expect(currentExecutable(path)?.sha256()).toBe(createHash("sha256").update("0123456789").digest("hex"));
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("hashing returns null when the file goes away underneath it", () => {
    const path = join(tmpdir(), `mcp-cli-exe-vanish-${process.pid}`);
    writeFileSync(path, "0123456789", "utf-8");
    const exe = currentExecutable(path);
    rmSync(path, { force: true });
    expect(exe?.sha256()).toBeNull();
  });

  test("returns null for a path that doesn't exist", () => {
    expect(currentExecutable(join(tmpdir(), "definitely-not-a-binary-3260"))).toBeNull();
  });
});
