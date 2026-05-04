import { describe, expect, test } from "bun:test";
import type { SiteSpec } from "./engine";
import { type OpenPageLike, openSitesInContext, partitionSitesForRunningBrowser } from "./playwright";

function fakePage(opts: { failGoto?: string } = {}): OpenPageLike & {
  gotoCalls: string[];
  broughtToFront: number;
} {
  const page = {
    gotoCalls: [] as string[],
    broughtToFront: 0,
    async goto(url: string): Promise<unknown> {
      page.gotoCalls.push(url);
      if (opts.failGoto) throw new Error(opts.failGoto);
      return null;
    },
    async bringToFront(): Promise<void> {
      page.broughtToFront++;
    },
  };
  return page;
}

function fakeCtx(pages: ReturnType<typeof fakePage>[]): {
  newPage: () => Promise<ReturnType<typeof fakePage>>;
  created: ReturnType<typeof fakePage>[];
} {
  const ctx = {
    created: [] as ReturnType<typeof fakePage>[],
    newPage: async () => {
      const p = pages.shift();
      if (!p) throw new Error("test fakeCtx ran out of prepared pages");
      ctx.created.push(p);
      return p;
    },
  };
  return ctx;
}

const spec = (name: string, extra: Partial<SiteSpec> = {}): SiteSpec => ({
  name,
  url: `https://${name}.test/home`,
  profileDir: `/tmp/${name}`,
  ...extra,
});

describe("openSitesInContext — #1588 regression", () => {
  test("allocates a fresh page per site, navigates each, and brings first to front", async () => {
    const p1 = fakePage();
    const p2 = fakePage();
    const ctx = fakeCtx([p1, p2]);
    const pinned = new Map<string, OpenPageLike>();

    const results = await openSitesInContext(ctx, [spec("teams"), spec("owa")], (page, name) => {
      pinned.set(name, page);
    });

    expect(ctx.created).toEqual([p1, p2]); // fresh pages, not reused
    expect(p1.gotoCalls).toEqual(["https://teams.test/home"]);
    expect(p2.gotoCalls).toEqual(["https://owa.test/home"]);
    expect(p1.broughtToFront).toBe(1); // first site focused
    expect(p2.broughtToFront).toBe(0); // subsequent sites not focused
    expect(pinned.get("teams")).toBe(p1);
    expect(pinned.get("owa")).toBe(p2);
    expect(results).toEqual([
      { site: "teams", url: "https://teams.test/home", status: "navigated" },
      { site: "owa", url: "https://owa.test/home", status: "navigated" },
    ]);
  });

  test("records per-site failure without aborting sibling navigation", async () => {
    const p1 = fakePage({ failGoto: "net::ERR_NAME_NOT_RESOLVED" });
    const p2 = fakePage();
    const ctx = fakeCtx([p1, p2]);

    const results = await openSitesInContext(ctx, [spec("teams"), spec("owa")], () => {});

    expect(results).toEqual([
      {
        site: "teams",
        url: "https://teams.test/home",
        status: "failed",
        error: "net::ERR_NAME_NOT_RESOLVED",
      },
      { site: "owa", url: "https://owa.test/home", status: "navigated" },
    ]);
    expect(p2.gotoCalls).toEqual(["https://owa.test/home"]); // owa still navigated
    expect(p1.broughtToFront).toBe(1); // bringToFront still called on failed first site
  });

  test("still invokes onPage before navigation so listeners catch early requests", async () => {
    const p1 = fakePage();
    const ctx = fakeCtx([p1]);
    const order: string[] = [];
    p1.goto = async (url: string) => {
      order.push(`goto:${url}`);
      return null;
    };

    await openSitesInContext(ctx, [spec("teams")], (_page, name) => {
      order.push(`attach:${name}`);
    });

    expect(order).toEqual(["attach:teams", "goto:https://teams.test/home"]);
  });
});

describe("partitionSitesForRunningBrowser — #1594", () => {
  const profile = "/tmp/profile/default";

  test("already-open sites go to alreadyRunning", () => {
    const { alreadyRunning, toOpen, profileMismatch } = partitionSitesForRunningBrowser(profile, new Set(["teams"]), [
      spec("teams", { profileDir: profile }),
    ]);
    expect(alreadyRunning.map((s) => s.name)).toEqual(["teams"]);
    expect(toOpen).toHaveLength(0);
    expect(profileMismatch).toHaveLength(0);
  });

  test("new site with matching profile goes to toOpen", () => {
    const { alreadyRunning, toOpen, profileMismatch } = partitionSitesForRunningBrowser(profile, new Set(["teams"]), [
      spec("teams", { profileDir: profile }),
      spec("owa", { profileDir: profile }),
    ]);
    expect(alreadyRunning.map((s) => s.name)).toEqual(["teams"]);
    expect(toOpen.map((s) => s.name)).toEqual(["owa"]);
    expect(profileMismatch).toHaveLength(0);
  });

  test("new site with different profile goes to profileMismatch", () => {
    const otherProfile = "/tmp/other/default";
    const { alreadyRunning, toOpen, profileMismatch } = partitionSitesForRunningBrowser(profile, new Set(["teams"]), [
      spec("atlassian", { profileDir: otherProfile }),
    ]);
    expect(alreadyRunning).toHaveLength(0);
    expect(toOpen).toHaveLength(0);
    expect(profileMismatch.map((s) => s.name)).toEqual(["atlassian"]);
  });

  test("mixed batch: already-running + new-same-profile + mismatch", () => {
    const otherProfile = "/tmp/other/default";
    const { alreadyRunning, toOpen, profileMismatch } = partitionSitesForRunningBrowser(profile, new Set(["teams"]), [
      spec("teams", { profileDir: profile }),
      spec("owa", { profileDir: profile }),
      spec("atlassian", { profileDir: otherProfile }),
    ]);
    expect(alreadyRunning.map((s) => s.name)).toEqual(["teams"]);
    expect(toOpen.map((s) => s.name)).toEqual(["owa"]);
    expect(profileMismatch.map((s) => s.name)).toEqual(["atlassian"]);
  });

  test("all-new same-profile sites go to toOpen", () => {
    const { alreadyRunning, toOpen, profileMismatch } = partitionSitesForRunningBrowser(profile, new Set<string>(), [
      spec("teams", { profileDir: profile }),
      spec("owa", { profileDir: profile }),
    ]);
    expect(alreadyRunning).toHaveLength(0);
    expect(toOpen.map((s) => s.name)).toEqual(["teams", "owa"]);
    expect(profileMismatch).toHaveLength(0);
  });

  test("trailing-slash profileDir is treated as matching the normalized running profile — #1671", () => {
    // partitionSitesForRunningBrowser calls path.resolve() on both s.profileDir
    // and runningProfile before comparing, so equivalent paths that differ only
    // in string format (trailing sep, doubled sep) must still match.
    const profileWithSlash = `${profile}/`;
    const { toOpen, profileMismatch } = partitionSitesForRunningBrowser(profile, new Set<string>(), [
      spec("owa", { profileDir: profileWithSlash }),
    ]);
    expect(toOpen.map((s) => s.name)).toEqual(["owa"]);
    expect(profileMismatch).toHaveLength(0);
  });
});
