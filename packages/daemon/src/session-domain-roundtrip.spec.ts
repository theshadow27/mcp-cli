/**
 * The partition, exercised through a REAL session worker — not through the classifier.
 *
 * `session-domain.spec.ts` asserts that `classifyAgentTool` calls `*_wait` a filter
 * tool. That assertion passed for every provider while four of five workers accepted
 * the resolved `domainId` and then threw it away: `handleSessionList` filtered,
 * `handleWait` twenty lines below did not, and the any-session path raced every
 * session in the process. The classifier was the half that was already right.
 *
 * So these tests drive the actual worker over the actual MCP client and assert what an
 * orchestrator actually depends on: a call scoped to domain A does not return, and does
 * not WAKE ON, a session in domain B. Mock is the only provider that spawns without an
 * external binary, so it is the one that can be tested this way; the other three carry
 * the identical `handleWait` shape and are held by the `session-wait-domain-scoped`
 * doing-it-wrong rule, which fails the build if any of them stops reading the filter.
 *
 * Every test here fails against the pre-fix worker.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NO_DOMAIN_ID, silentLogger } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { MockServer } from "./mock-server";
import { applyDomainScope } from "./session-domain";

setDefaultTimeout(15_000);

describe("domain partition — round trip through a real worker", () => {
  let db: StateDb | undefined;
  let server: MockServer | undefined;
  let opts: ReturnType<typeof testOptions> | undefined;
  let client: Awaited<ReturnType<MockServer["start"]>>["client"];
  let alpha: string;
  let beta: string;
  let alphaId: number;
  let betaId: number;

  async function setup(): Promise<void> {
    opts = testOptions();
    alpha = join(opts.dir, "alpha");
    beta = join(opts.dir, "beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });

    db = new StateDb(opts.DB_PATH);
    alphaId = db.createDomain("alpha", alpha).id;
    betaId = db.createDomain("beta", beta).id;

    server = new MockServer(db, undefined, undefined, silentLogger);
    const { client: c } = await server.start();
    client = c;
  }

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
    opts?.[Symbol.dispose]();
  });

  /** A script that never completes on its own, so the session stays live for `wait`. */
  function idleScript(name: string, dir: string): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify([{ delay: 60_000, text: "still going" }]));
    return path;
  }

  /** Spawn through the same arg-rewriting the daemon's callTool handler performs. */
  async function spawnIn(dir: string, script: string): Promise<string> {
    if (!db) throw new Error("setup() not called");
    const args = applyDomainScope(db, "_mock", "mock_prompt", { prompt: script, cwd: dir }, undefined);
    const result = await client.callTool({ name: "mock_prompt", arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return (JSON.parse(content[0].text) as { sessionId: string }).sessionId;
  }

  async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!db) throw new Error("setup() not called");
    const scoped = applyDomainScope(db, "_mock", tool, args, undefined);
    const result = await client.callTool({ name: tool, arguments: scoped });
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text);
  }

  test("session_list scoped to a domain excludes the other domain's session", async () => {
    await setup();
    const a = await spawnIn(alpha, idleScript("a.json", alpha));
    const b = await spawnIn(beta, idleScript("b.json", beta));

    const fromAlpha = (await call("mock_session_list", { domainCwd: alpha })) as Array<{ sessionId: string }>;
    const fromBeta = (await call("mock_session_list", { domainCwd: beta })) as Array<{ sessionId: string }>;
    const all = (await call("mock_session_list", {})) as Array<{ sessionId: string }>;

    expect(fromAlpha.map((s) => s.sessionId)).toEqual([a]);
    expect(fromBeta.map((s) => s.sessionId)).toEqual([b]);
    expect(all.map((s) => s.sessionId).sort()).toEqual([a, b].sort());
  });

  test("WAIT scoped to a domain does not wake on the other domain's session", async () => {
    // The blocker: `wait` accepted the filter, advertised it in the tool schema, and
    // ignored it — so an orchestrator blocking here read a completion for a session it
    // does not own and advanced the wrong work item.
    await setup();
    await spawnIn(alpha, idleScript("a.json", alpha));

    // A script that finishes immediately, in BETA. Pre-fix, the any-session wait raced
    // every session in the process and returned this one to an alpha-scoped caller.
    const quick = join(beta, "quick.json");
    writeFileSync(quick, JSON.stringify([{ text: "done" }]));
    await spawnIn(beta, quick);

    const woke = (await call("mock_wait", { domainCwd: alpha, timeout: 1200 })) as Array<{ sessionId: string }>;

    // Alpha's session never completes, so the scoped wait must time out and report
    // ONLY alpha's sessions — never beta's, in the event or in the fallback list.
    expect(Array.isArray(woke)).toBe(true);
    for (const s of woke) {
      expect(db?.getSession(s.sessionId)?.domainId).toBe(alphaId);
    }
  });

  test("a wait scoped to a domain with no sessions returns empty, not everyone else's", async () => {
    await setup();
    await spawnIn(beta, idleScript("b.json", beta));

    const woke = (await call("mock_wait", { domain: "alpha", timeout: 800 })) as unknown[];
    expect(woke).toEqual([]);
  });

  test("an unscoped wait still sees every session", async () => {
    await setup();
    await spawnIn(alpha, idleScript("a.json", alpha));
    await spawnIn(beta, idleScript("b.json", beta));

    const woke = (await call("mock_wait", { timeout: 800 })) as Array<{ sessionId: string }>;
    expect(woke.length).toBe(2);
  });

  test("a scoped `wait --after` still finds its OWN domain's events after the session ENDS", async () => {
    // The gap the round-trip previously left: it covered the any-session path and the
    // timeout fallback, but nothing drove the afterSeq REPLAY path — which is where the
    // bug lived. `handleBye` fires `session:ended`, which DELETES the session from the
    // live map, while the event buffer survives. Attributing a buffered event by looking
    // its emitter up in that map therefore lost the event the moment the session ended.
    //
    // This is the default path, not an opt-in one: `mcx agent … wait --after N` sends
    // domainCwd unconditionally. The caller stands in the session's OWN domain and the
    // answer was `[]` — indistinguishable from "nothing is running".
    await setup();
    const id = await spawnIn(alpha, idleScript("a.json", alpha));

    // Buffered while live, so there is something to replay.
    const before = (await call("mock_wait", { domainCwd: alpha, afterSeq: 0, timeout: 1500 })) as { seq?: number };
    expect(before.seq).toBeGreaterThan(0);

    // End it — the session leaves the live map, the buffer does not.
    await call("mock_bye", { sessionId: id });
    expect((await call("mock_session_list", {})) as unknown[]).toEqual([]);

    const scoped = (await call("mock_wait", { domainCwd: alpha, afterSeq: 0, timeout: 1500 })) as { seq?: number };
    const unscoped = (await call("mock_wait", { afterSeq: 0, timeout: 1500 })) as { seq?: number };

    // Whatever the unscoped caller can still see in the buffer, the in-domain caller
    // must see too. Pre-fix, `unscoped` found the event and `scoped` returned nothing.
    expect(unscoped.seq).toBe(before.seq);
    expect(scoped.seq).toBe(unscoped.seq);
  });

  test("a scoped `wait --after` still EXCLUDES another domain's ended session", async () => {
    // The fix must not become "attribute nothing, admit everything".
    await setup();
    const id = await spawnIn(beta, idleScript("b.json", beta));
    await call("mock_wait", { afterSeq: 0, timeout: 1500 });
    await call("mock_bye", { sessionId: id });

    const fromAlpha = (await call("mock_wait", { domainCwd: alpha, afterSeq: 0, timeout: 900 })) as unknown;
    const seen = Array.isArray(fromAlpha) ? fromAlpha : [fromAlpha];
    expect(seen).toEqual([]);
  });

  test("the spawn actually persisted a real domain id, not the sentinel", async () => {
    await setup();
    const a = await spawnIn(alpha, idleScript("a.json", alpha));
    const b = await spawnIn(beta, idleScript("b.json", beta));

    expect(db?.getSession(a)?.domainId).toBe(alphaId);
    expect(db?.getSession(b)?.domainId).toBe(betaId);
    expect(db?.getSession(a)?.domainId).not.toBe(NO_DOMAIN_ID);
  });
});
