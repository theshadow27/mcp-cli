/**
 * Adopt rows written before their domain existed (#3040).
 *
 * The hazard this closes, reproduced before it was written: a phase script writes
 * `ctx.state` while no domain is registered, so the row lands on `domain_id = 0`. Later a
 * domain appears — and it appears *by itself*, because `importScopesAsDomains` turns every
 * `~/.mcp-cli/scopes/*.json` sidecar into a domain row at daemon boot. The next read
 * resolves a real domain id, queries `(N, repo_root, namespace, key)`, and finds nothing.
 * The value is still there, one column away, and `ctx.state.get()` returns `undefined`.
 * Nothing errors. No user action caused it.
 *
 * The one-shot import stamps the rows it copies, but it seals itself and never runs again
 * — so a box that had already booted a post-#3034 daemon before the domain-scoped readers
 * landed would never be stamped, and its only recovery would be raw `sqlite3` or
 * `mcx domain rm`, which is #3035 and has not shipped. A partition whose recovery command
 * does not exist yet is not a partition anyone should be forced into, so this runs at
 * every boot instead: idempotent, cheap, and independent of the import marker.
 *
 * Adoption is deliberately one-way and narrow: it only ever moves rows OFF the sentinel,
 * and only when their recorded root resolves to a registered domain. It never moves a row
 * between two real domains and never moves one back to 0.
 */

import type { Database } from "bun:sqlite";
import { type Domain, NO_DOMAIN_ID, resolveDomainForPath } from "@mcp-cli/core";

export interface AdoptResult {
  /** Rows moved from the sentinel onto a real domain. */
  stamped: number;
  /**
   * Rows left on the sentinel because the destination already holds that exact key.
   *
   * Skipped rather than merged: two rows for one `(domain, repo_root, namespace, key)`
   * means the domain-scoped writer has already written its own value, and silently
   * overwriting it with an older un-domained one would be a worse outcome than leaving a
   * row behind. Counted and logged so it is visible rather than inferred.
   *
   * Per row, not per root — a sibling key under the same root that the destination has
   * never held is adopted normally and is not counted here (#3213).
   */
  collided: number;
}

/** Tables carrying both a `domain_id` and a recoverable root, with the SQL naming that root. */
export const ADOPTABLE_TABLES: ReadonlyArray<{ table: string; rootExpr: string }> = [
  { table: "alias_state", rootExpr: "repo_root" },
  { table: "monitor_events", rootExpr: "json_extract(payload, '$.repoRoot')" },
];

/**
 * Move sentinel rows in one table onto the domain their recorded root resolves to.
 *
 * `onCollision` is the only behavioural difference between the two callers, and it is a
 * real difference rather than a knob: inside the one-shot import a collision must abort so
 * the whole copy rolls back and retries (seal-or-nothing), while at daemon boot there is
 * nothing to roll back and a start must not be blocked by one unadoptable row.
 */
export function adoptUnassignedRows(
  db: Database,
  domains: Domain[],
  spec: { table: string; rootExpr: string },
  onCollision: "throw" | "skip",
  log: (msg: string) => void,
): AdoptResult {
  const result: AdoptResult = { stamped: 0, collided: 0 };
  if (domains.length === 0) return result;

  const { table, rootExpr } = spec;

  // One UPDATE per root, but `alias_state`'s primary key is per KEY
  // — (domain_id, repo_root, namespace, key). SQLite's default ON CONFLICT ABORT therefore
  // rolls back the *whole* statement when a single key already exists at the destination,
  // stranding every non-colliding sibling under that root (#3213). OR IGNORE narrows the
  // conflict to the one row that actually collides, which is the policy this function has
  // always documented: the live value wins, and only that key stays behind.
  //
  // The import keeps the bare form on purpose — there a conflict must abort so the whole
  // copy rolls back and retries (seal-or-nothing, #3040 review R4).
  const update = `UPDATE ${onCollision === "skip" ? "OR IGNORE " : ""}${table} SET domain_id = ? WHERE domain_id = ${NO_DOMAIN_ID} AND ${rootExpr} = ?`;

  const roots = db
    .query<{ root: string | null }, []>(
      `SELECT DISTINCT ${rootExpr} AS root FROM ${table} WHERE domain_id = ${NO_DOMAIN_ID}`,
    )
    .all();

  for (const { root } of roots) {
    if (typeof root !== "string" || root === "") continue;

    let id = NO_DOMAIN_ID;
    try {
      // Roots are stored canonical by their writers, so this stays a pure lookup — no
      // realpath, and no throw on a root whose directory has since been deleted.
      id = resolveDomainForPath(root, domains)?.id ?? NO_DOMAIN_ID;
    } catch {
      continue; // not an absolute path — nothing to resolve, leave it alone
    }
    if (id === NO_DOMAIN_ID) continue;

    result.stamped += db.run(update, [id, root]).changes;
    if (onCollision === "throw") continue; // a conflict threw; nothing was left behind

    // Whatever is still on the sentinel for this root is exactly what OR IGNORE skipped.
    const remaining =
      db
        .query<{ n: number }, [string]>(
          `SELECT count(*) AS n FROM ${table} WHERE domain_id = ${NO_DOMAIN_ID} AND ${rootExpr} = ?`,
        )
        .get(root)?.n ?? 0;
    if (remaining === 0) continue;

    result.collided += remaining;
    log(
      `[domains] ${table}: left ${remaining} row(s) for ${root} on the unassigned partition — domain ${id} already holds those ${remaining === 1 ? "key" : "keys"} and its live value wins; the other rows for this root were adopted`,
    );
  }

  return result;
}

/**
 * Boot-time adoption across every adoptable table. Never throws: a daemon must start.
 *
 * Cheap by construction — the `WHERE domain_id = 0` scan finds nothing on every boot after
 * the first, because adoption only ever moves rows off the sentinel.
 */
export function adoptUnassignedDomains(db: Database, domains: Domain[], log: (msg: string) => void): AdoptResult {
  const total: AdoptResult = { stamped: 0, collided: 0 };
  if (domains.length === 0) return total;

  for (const spec of ADOPTABLE_TABLES) {
    try {
      const r = adoptUnassignedRows(db, domains, spec, "skip", log);
      total.stamped += r.stamped;
      total.collided += r.collided;
    } catch (err) {
      // A table this database's consumers never created. Nothing to adopt, and certainly
      // not a reason to fail startup.
      log(`[domains] ${spec.table}: skipped adoption — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return total;
}
