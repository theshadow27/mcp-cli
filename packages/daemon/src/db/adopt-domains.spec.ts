/**
 * The partition-closing hazard, and the adoption that closes it (#3040).
 *
 * Driven with a domain REGISTERED and a caller standing both inside and outside it,
 * because a fresh box where `listDomains()` is empty makes every one of these pass
 * vacuously — which is exactly how this class of defect stays invisible.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { createDomainResolver, createStateDbDomainSource } from "../domain-resolver";
import { adoptUnassignedDomains } from "./adopt-domains";
import { StateDb } from "./state";

const dirs: string[] = [];
const open: StateDb[] = [];

afterEach(() => {
  for (const d of open) d.close();
  open.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "mcx-adopt-"));
  dirs.push(home);
  const inside = join(home, "myrepo");
  const outside = join(home, "elsewhere");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const db = new StateDb(join(home, "mcx.db"));
  open.push(db);
  return { db, inside, outside };
}

const silent = () => {};

describe("state written before a domain existed", () => {
  test("is reachable again after adoption — the hazard, and the fix", () => {
    const { db, inside } = setup();

    // Pre-domain: a phase script writes ctx.state. Resolves to the sentinel.
    const before = createDomainResolver(createStateDbDomainSource(db));
    expect(before.idForPath(inside)).toBe(NO_DOMAIN_ID);
    db.setAliasState(inside, "workitem:#42", "round", 3, NO_DOMAIN_ID);

    // A domain appears with no user action — importScopesAsDomains does this at boot
    // from any ~/.mcp-cli/scopes/*.json sidecar.
    const domain = db.createDomain("myrepo", inside);

    // Without adoption the read is silently empty. This is the premise: assert the
    // hazard is real, so the fix below cannot pass for the wrong reason.
    expect(db.getAliasState(inside, "workitem:#42", "round", domain.id)).toBeUndefined();
    expect(db.getAliasState(inside, "workitem:#42", "round", NO_DOMAIN_ID)).toBe(3);

    // Boot-time adoption.
    const result = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(result.stamped).toBeGreaterThan(0);

    // The next daemon boot resolves a real domain and finds the value.
    const after = createDomainResolver(createStateDbDomainSource(db));
    expect(db.getAliasState(inside, "workitem:#42", "round", after.idForPath(inside))).toBe(3);
  });

  test("a nested repo root inside the domain is adopted too", () => {
    const { db, inside } = setup();
    const nested = join(inside, "packages", "core");
    mkdirSync(nested, { recursive: true });
    db.setAliasState(nested, "ns", "k", "v", NO_DOMAIN_ID);
    const domain = db.createDomain("myrepo", inside);

    adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(db.getAliasState(nested, "ns", "k", domain.id)).toBe("v");
  });

  test("a caller OUTSIDE every domain is untouched and still reads its own state", () => {
    const { db, inside, outside } = setup();
    db.setAliasState(outside, "ns", "k", "mine", NO_DOMAIN_ID);
    db.createDomain("myrepo", inside);

    adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);

    const resolver = createDomainResolver(createStateDbDomainSource(db));
    expect(resolver.idForPath(outside)).toBe(NO_DOMAIN_ID);
    expect(db.getAliasState(outside, "ns", "k", NO_DOMAIN_ID)).toBe("mine");
  });

  test("adoption is idempotent — a second boot changes nothing", () => {
    const { db, inside } = setup();
    db.setAliasState(inside, "ns", "k", "v", NO_DOMAIN_ID);
    db.createDomain("myrepo", inside);

    const first = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    const second = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(first.stamped).toBeGreaterThan(0);
    expect(second.stamped).toBe(0);
    expect(second.collided).toBe(0);
  });

  test("with no domains registered, adoption is a no-op", () => {
    const { db, inside } = setup();
    db.setAliasState(inside, "ns", "k", "v", NO_DOMAIN_ID);
    expect(adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent)).toEqual({ stamped: 0, collided: 0 });
    expect(db.getAliasState(inside, "ns", "k", NO_DOMAIN_ID)).toBe("v");
  });

  test("a collision leaves the row rather than overwriting the domain's own value", () => {
    const { db, inside } = setup();
    const domain = db.createDomain("myrepo", inside);
    // The domain-scoped writer already wrote this key...
    db.setAliasState(inside, "ns", "k", "current", domain.id);
    // ...and an older un-domained row exists for the same key.
    db.getDatabase().run(
      "INSERT INTO alias_state (domain_id, repo_root, namespace, key, value_json) VALUES (?, ?, ?, ?, ?)",
      [NO_DOMAIN_ID, inside, "ns", "k", '"stale"'],
    );

    const result = adoptUnassignedDomains(db.getDatabase(), db.listDomains(), silent);
    expect(result.collided).toBe(1);
    // The live value wins; the stale row is left behind, not merged over it.
    expect(db.getAliasState(inside, "ns", "k", domain.id)).toBe("current");
  });
});
