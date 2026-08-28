/**
 * `-d <domain>` on the work-item IPC methods (#3036).
 *
 * The CLI half — refusing to act when no domain resolves — lives in
 * `packages/command/src/domain-guard.ts` and is tested there. This is the daemon half: an
 * explicitly named domain has to actually redirect the partition, an unknown name has to
 * fail rather than fall through to the caller's cwd, and `"_"` has to reach partition 0.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Domain, IpcMethod } from "@mcp-cli/core";
import { WorkItemDb } from "../db/work-items";
import type { RequestHandler } from "../handler-types";
import { WorkItemHandlers } from "./work-item";

const PHOENIX: Domain = { id: 7, name: "phoenix", host: null, path: "/srv/phoenix", createdAt: "2026-08-26" };
const MCP_CLI: Domain = { id: 9, name: "mcp-cli", host: null, path: "/srv/mcp-cli", createdAt: "2026-08-26" };
const DOMAINS = [PHOENIX, MCP_CLI];

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * A McxDb stub holding only what domain resolution needs: name lookup, and the longest-
 * prefix path walk-up. Narrow on purpose — the point under test is which id the handler
 * picks, not how `resolveDomainForPath` computes one.
 */
function domainDb() {
  return {
    getDomainByName: (name: string): Domain | null => DOMAINS.find((d) => d.name === name) ?? null,
    resolveDomain: (path: string): Domain | null =>
      DOMAINS.filter((d) => path === d.path || path.startsWith(`${d.path}/`)).sort(
        (a, b) => b.path.length - a.path.length,
      )[0] ?? null,
    // `aliasState*` is not exercised here; those handlers derive their domain from repoRoot
    // and deliberately take no `domain` field (see the note above them in work-item.ts).
  };
}

function buildHandlers() {
  const workItemDb = new WorkItemDb(new Database(":memory:"));
  const map = new Map<IpcMethod, RequestHandler>();
  new WorkItemHandlers(workItemDb, domainDb() as never, null, null, noopLogger as never).register(map);
  return { map, workItemDb };
}

const ctx = {} as never;

/** Items visible to a given scope input, as ids — the observable partition. */
async function listedIn(map: Map<IpcMethod, RequestHandler>, params: unknown): Promise<string[]> {
  const { items } = (await invoke(map, "listWorkItems")(params, ctx)) as { items: Array<{ id: string }> };
  return items.map((i) => i.id);
}

describe("work-item domain scoping", () => {
  test("an explicit domain wins over the caller's cwd", async () => {
    const { map } = buildHandlers();
    // Standing in phoenix, but naming mcp-cli: the item must land in mcp-cli.
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/srv/phoenix/pkg", domain: "mcp-cli" }, ctx);

    // Ids are domain-qualified, so the partition is directly readable: `d9:` is mcp-cli.
    expect(await listedIn(map, { cwd: "/srv/mcp-cli" })).toEqual(["d9:#42"]);
    expect(await listedIn(map, { cwd: "/srv/phoenix/pkg" })).toEqual([]);
  });

  test("without a domain, the caller's cwd still decides", async () => {
    const { map } = buildHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/srv/phoenix/pkg" }, ctx);

    expect(await listedIn(map, { cwd: "/srv/phoenix" })).toEqual(["d7:#42"]);
    expect(await listedIn(map, { cwd: "/srv/mcp-cli" })).toEqual([]);
  });

  test("a named domain reads the same partition it wrote", async () => {
    const { map } = buildHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/tmp", domain: "phoenix" }, ctx);

    expect(await listedIn(map, { cwd: "/tmp", domain: "phoenix" })).toEqual(["d7:#42"]);
    const got = (await invoke(map, "getWorkItem")({ number: 42, cwd: "/tmp", domain: "phoenix" }, ctx)) as {
      id: string;
    } | null;
    expect(got?.id).toBe("d7:#42");
  });

  test("untrack honours the named domain rather than the cwd", async () => {
    const { map } = buildHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/srv/phoenix" }, ctx);
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/srv/mcp-cli" }, ctx);

    const result = (await invoke(map, "untrackWorkItem")(
      { number: 42, cwd: "/srv/phoenix", domain: "mcp-cli" },
      ctx,
    )) as { deleted: boolean };
    expect(result.deleted).toBe(true);

    // The one named was removed; the one the cwd pointed at survived.
    expect(await listedIn(map, { cwd: "/srv/mcp-cli" })).toEqual([]);
    expect(await listedIn(map, { cwd: "/srv/phoenix" })).toEqual(["d7:#42"]);
  });

  // The whole point: falling back would make `-d phoenex` a typo that silently acts on
  // wherever the shell happened to be — worse than the unscoped call it replaced.
  test.each(["trackWorkItem", "untrackWorkItem", "listWorkItems", "getWorkItem"] as const)(
    "%s rejects an unknown domain instead of falling back to cwd",
    async (method) => {
      const { map } = buildHandlers();
      const params = { number: 42, cwd: "/srv/phoenix", domain: "phoenex" };
      await expect(invoke(map, method)(params, ctx)).rejects.toThrow(/unknown domain "phoenex"/);
    },
  );

  test("the unknown-domain error names the escape hatch", async () => {
    const { map } = buildHandlers();
    await expect(invoke(map, "listWorkItems")({ domain: "nope" }, ctx)).rejects.toThrow(/mcx domain add/);
  });

  // Partition 0 is where every row written before domains existed lives, so it is
  // addressable on purpose — by name, not by omitting the flag.
  test('"_" addresses the unassigned partition from inside a real domain', async () => {
    const { map } = buildHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/srv/phoenix", domain: "_" }, ctx);

    expect(await listedIn(map, { cwd: "/srv/phoenix" })).toEqual([]);
    expect(await listedIn(map, { cwd: "/tmp" })).toEqual(["#42"]);
    expect(await listedIn(map, { cwd: "/srv/phoenix", domain: "_" })).toEqual(["#42"]);
  });

  test("a cwd outside every domain still resolves to the unassigned partition", async () => {
    const { map } = buildHandlers();
    await invoke(map, "trackWorkItem")({ number: 42, cwd: "/tmp" }, ctx);
    expect(await listedIn(map, { cwd: "/var/empty" })).toEqual(["#42"]);
  });
});
