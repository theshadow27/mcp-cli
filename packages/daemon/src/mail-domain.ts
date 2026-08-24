/**
 * Mail domain resolution — the partition rule for `mail`, as a function (#3038).
 *
 * ## The invariant
 *
 * > A mail row belongs to exactly one domain partition, and no read, wait, reply or
 * > mark-read ever observes a row outside the caller's partition. Crossing a partition
 * > boundary requires an explicit `user@domain`.
 *
 * Every mail path routes through {@link resolveCallerDomain} and {@link resolveDelivery};
 * every `StateDb` mail method takes `domainId` as a **required first parameter**, so a
 * call site that has not thought about the partition does not typecheck. This module is
 * the "function, not prose" half of that — `docs/domains.md` describes the rule, but the
 * rule is enforced here.
 *
 * ## Partition 0 is a partition, not a fallback
 *
 * Rows written before any domain was resolved carry `domain_id = 0`. On an existing
 * install that is the **entire mail history**, so partition 0 is not an edge case to be
 * tolerated — it is where the data is. It is therefore a first-class, addressable
 * partition with a reserved name ({@link UNASSIGNED_DOMAIN_NAME}, `_`): reachable by
 * `-d _`, addressable as `boss@_`, and usable as a return address.
 *
 * An earlier revision made it a **carve-out** — partition 0 only when `domains` happened
 * to be empty — and that was a merge-blocking defect, not a style problem. The `domains`
 * table is auto-populated on daemon boot by `importScopesAsDomains` from
 * `~/.mcp-cli/scopes/*.json`, with no user action. On any box that ever ran `mcx scope`,
 * one domain appears at boot, the carve-out closes, and every mail call from outside that
 * one directory throws — orphaning the whole mail history, including the operator
 * mailbox that sprint workers use to report being blocked. The reasoning error was
 * concluding "the table is always empty" from "no *command* writes it".
 *
 * So: a caller outside every registered domain resolves to partition 0, **always** —
 * not conditionally. That is a total function, not a guess: every caller maps to exactly
 * one partition, deterministically, and the answer never depends on how many other
 * domains happen to exist. What `docs/domains.md` forbids is inventing an *arbitrary*
 * domain for an un-domained caller; partition 0 is the opposite of arbitrary.
 *
 * ## Failure directions
 *
 * Every remaining failure fails **closed**: it throws, and the caller delivers nothing
 * and reads nothing. There is no branch that widens a query, drops the `domain_id`
 * predicate, or falls back to a *named* domain the caller did not ask for — a mail
 * system that degrades to "show everything" on an unresolved domain is worse than one
 * that refuses, because the failure is invisible to both parties.
 */

import {
  type Domain,
  IPC_ERROR,
  NO_DOMAIN_ID,
  UNASSIGNED_DOMAIN_NAME,
  formatMailAddress,
  isUnassignedDomainName,
  parseMailAddress,
} from "@mcp-cli/core";

/** The partition a mail operation acts on. Always named — partition 0 included. */
export interface MailDomain {
  id: number;
  /** The domain's name, or {@link UNASSIGNED_DOMAIN_NAME} for partition 0. Never null. */
  name: string;
}

/** The unassigned partition, as a fully addressable domain. */
export const UNASSIGNED_MAIL_DOMAIN: MailDomain = { id: NO_DOMAIN_ID, name: UNASSIGNED_DOMAIN_NAME };

/** The slice of `StateDb` mail resolution needs. Narrow on purpose — this unit-tests without a daemon. */
export interface MailDomainDb {
  getDomainByName(name: string): Domain | null;
  resolveDomain(path: string): Domain | null;
}

/** How a caller identifies the partition it is acting in. Supplied by every mail IPC method and MCP tool. */
export interface MailScope {
  /** The caller's working directory. Resolved through the domains table. */
  cwd?: string;
  /** An explicit domain name (`mcx mail -d <domain>`). Wins over `cwd`. */
  domain?: string;
}

function invalidParams(message: string): Error {
  return Object.assign(new Error(message), { code: IPC_ERROR.INVALID_PARAMS });
}

function toMailDomain(domain: Domain): MailDomain {
  return { id: domain.id, name: domain.name };
}

function hostBoundError(domain: Domain): Error {
  return invalidParams(
    `domain ${JSON.stringify(domain.name)} is host-bound (${domain.host}) — cross-host mail routing is not implemented`,
  );
}

/**
 * Look up a domain **by name**, including the reserved name for partition 0.
 *
 * Single lookup path so `-d _` and `user@_` cannot disagree about what `_` means.
 * Returns `null` for a name that is neither reserved nor registered; callers throw.
 *
 * Refuses a host-bound domain rather than silently delivering into the local `mail`
 * table: `resolveDomainForPath` (`core/src/domain.ts`) already skips `host`-bound rows
 * because a domain's location can be a directory on another machine, and mail is a
 * writer into that same local database — nobody on the remote host will ever read a row
 * landed here. Fails closed, matching every other mail failure direction (#3038 review
 * finding #6).
 */
function lookupDomainByName(db: MailDomainDb, name: string): MailDomain | null {
  if (isUnassignedDomainName(name)) return UNASSIGNED_MAIL_DOMAIN;
  const found = db.getDomainByName(name);
  if (!found) return null;
  if (found.host !== null) throw hostBoundError(found);
  return toMailDomain(found);
}

/**
 * Which partition is this caller acting in?
 *
 * 1. `domain` (from `-d`) wins, and must name a registered domain or the reserved
 *    `_` — an unknown name is an error, never a silently-created partition.
 * 2. Otherwise `cwd` is resolved through the domains table (longest matching prefix).
 * 3. A `cwd` outside every registered domain is **partition 0**, always. See the header:
 *    this is the property that keeps mail working on a box where a domain row appeared
 *    at daemon boot without anyone asking for it.
 * 4. Neither supplied is an error. The daemon's own `process.cwd()` is never consulted:
 *    it is the cwd of whatever directory `mcpd` happened to start in, which has no
 *    relationship to the caller's.
 */
export function resolveCallerDomain(db: MailDomainDb, scope: MailScope): MailDomain {
  const explicit = scope.domain?.trim();
  if (explicit) {
    const found = lookupDomainByName(db, explicit);
    if (!found) {
      throw invalidParams(
        `unknown domain ${JSON.stringify(explicit)} — register it with \`mcx domain add\`, or use "${UNASSIGNED_DOMAIN_NAME}" for the unassigned partition`,
      );
    }
    return found;
  }

  const cwd = scope.cwd?.trim();
  if (!cwd) {
    throw invalidParams("mail requires a domain scope: pass the caller's cwd, or name one with -d <domain>");
  }

  const resolved = db.resolveDomain(cwd);
  if (!resolved) return UNASSIGNED_MAIL_DOMAIN;
  if (resolved.host !== null) throw hostBoundError(resolved);
  return toMailDomain(resolved);
}

/** Where a message is going, and how it is stamped once it gets there. */
export interface MailDelivery {
  /** The partition the row is written into — the **recipient's** domain, not the sender's. */
  domain: MailDomain;
  /** The `recipient` column value: always the bare local part. The partition carries the domain. */
  recipient: string;
  /**
   * The `sender` column value. Bare when sender and recipient share a partition; qualified
   * `local@sender-domain` when the message crossed a boundary, so a reply routes back.
   */
  sender: string;
  /** True when this message crossed a partition boundary. */
  crossDomain: boolean;
}

/**
 * Resolve a send: where does `recipient` live, and how is `sender` written down there?
 *
 * - A **bare** recipient resolves to the caller's own partition. It never means "any
 *   domain" and never means "search other domains too".
 * - `user@domain` resolves by name, `_` included. An unknown domain is an error at
 *   **send** time — the acceptance criterion #3038 names — rather than a row written
 *   into a partition nobody reads.
 * - A `sender` may carry `@domain` only if it is the caller's own. Otherwise any caller
 *   could stamp a message as coming from another domain and steer the reply into it.
 *   `parseMailAddress` separately guarantees the local part holds no second address, so
 *   this check cannot be bypassed by burying one in the local half.
 *
 * Cross-domain traffic does not become an ambient channel because it is per-message and
 * one-directional: the row lands in the recipient's partition and is readable only there.
 * There is no query anywhere that returns rows from more than one partition, so a domain
 * cannot observe another domain's traffic — only receive a message a named sender chose
 * to address to it.
 *
 * Note there is deliberately **no** "sender has no return address" branch any more. Every
 * partition is named, partition 0 included, so a return address always exists. The
 * previous revision had such a guard and it was **unreachable against a real `StateDb`**:
 * reaching it required an unassigned caller while `domains` was non-empty, and the old
 * carve-out made that state impossible. Only a hand-written fake could produce it, so
 * mutation-testing it against a fake-based spec proved the fake was wired to the guard,
 * not that the guard ran.
 */
export function resolveDelivery(
  db: MailDomainDb,
  caller: MailDomain,
  senderRaw: string,
  recipientRaw: string,
): MailDelivery {
  const sender = parseMailAddress(senderRaw);
  if (sender.domain !== null && sender.domain !== caller.name) {
    throw invalidParams(
      `cannot send as ${JSON.stringify(senderRaw)} from domain ${JSON.stringify(caller.name)} — a sender may only be qualified with its own domain`,
    );
  }

  const recipient = parseMailAddress(recipientRaw);
  if (recipient.domain === null) {
    return { domain: caller, recipient: recipient.local, sender: sender.local, crossDomain: false };
  }

  const target = lookupDomainByName(db, recipient.domain);
  if (!target) {
    throw invalidParams(
      `unknown domain ${JSON.stringify(recipient.domain)} in recipient ${JSON.stringify(recipientRaw)} — register it with \`mcx domain add\` (see \`mcx domain ls\`)`,
    );
  }

  if (target.id === caller.id) {
    return { domain: caller, recipient: recipient.local, sender: sender.local, crossDomain: false };
  }

  return {
    domain: target,
    recipient: recipient.local,
    sender: formatMailAddress({ local: sender.local, domain: caller.name }),
    crossDomain: true,
  };
}
