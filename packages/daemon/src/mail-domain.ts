/**
 * Mail domain resolution — the partition rule for `mail`, as a function (#3038).
 *
 * ## The invariant
 *
 * > A mail row belongs to exactly one domain partition, and no read, wait, reply or
 * > mark-read ever observes a row outside the caller's partition. Crossing a partition
 * > boundary requires an explicit `user@domain` recipient **and** a sender that itself
 * > has a return address.
 *
 * Every mail path routes through {@link resolveCallerDomain} and {@link resolveDelivery};
 * every `StateDb` mail method takes `domainId` as a **required first parameter**, so a
 * call site that has not thought about the partition does not typecheck. This module is
 * the "function, not prose" half of that — `docs/domains.md` describes the rule, but the
 * rule is enforced here.
 *
 * ## Failure directions
 *
 * Every path in this module fails **closed**: it throws, and the caller delivers nothing
 * and reads nothing. There is deliberately no branch that widens the query, drops the
 * `domain_id` predicate, or falls back to a "default" domain — a mail system that
 * degrades to "show everything" on an unresolved domain is worse than one that refuses,
 * because the failure is invisible to both parties.
 *
 * The one place that does **not** throw is a caller whose cwd is outside every domain
 * *while the domains table is empty*: that resolves to the unassigned partition
 * ({@link NO_DOMAIN_ID}). This is not a guess and not a wildcard — it is the single
 * closed partition that literally means "no domain", and it is what makes mail work at
 * all before anyone has registered a domain. The moment one domain exists, an
 * unresolvable cwd becomes an error demanding `-d`, exactly as `docs/domains.md`
 * prescribes, because silently dropping into partition 0 alongside a live partition is
 * the silent misdelivery this epic exists to prevent.
 */

import { type Domain, IPC_ERROR, NO_DOMAIN_ID, formatMailAddress, parseMailAddress } from "@mcp-cli/core";

/** The partition a mail operation acts on: a real domain, or the unassigned sentinel. */
export interface MailDomain {
  id: number;
  /** The domain's name, or `null` for the unassigned partition — which has no name. */
  name: string | null;
}

/** The unassigned partition. Has no name, and therefore no return address. */
export const UNASSIGNED_MAIL_DOMAIN: MailDomain = { id: NO_DOMAIN_ID, name: null };

/** The slice of `StateDb` mail resolution needs. Narrow on purpose — this unit-tests without a daemon. */
export interface MailDomainDb {
  listDomains(): Domain[];
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

/**
 * Which partition is this caller acting in?
 *
 * 1. `domain` (from `-d`) wins, and must name a registered domain — an unknown name is
 *    an error, never a silently-created partition.
 * 2. Otherwise `cwd` is resolved through the domains table (longest matching prefix).
 * 3. A `cwd` outside every domain is an error demanding `-d` — **unless** no domains are
 *    registered at all, in which case there is exactly one partition and it is the
 *    unassigned one.
 * 4. Neither supplied is an error. The daemon's own `process.cwd()` is never consulted:
 *    it is the cwd of whatever directory `mcpd` happened to start in, which has no
 *    relationship to the caller's.
 */
export function resolveCallerDomain(db: MailDomainDb, scope: MailScope): MailDomain {
  const explicit = scope.domain?.trim();
  if (explicit) {
    const found = db.getDomainByName(explicit);
    if (!found) {
      throw invalidParams(`unknown domain ${JSON.stringify(explicit)} — register it with \`mcx domain add\``);
    }
    return toMailDomain(found);
  }

  const cwd = scope.cwd?.trim();
  if (!cwd) {
    throw invalidParams("mail requires a domain scope: pass the caller's cwd, or name one with -d <domain>");
  }

  const resolved = db.resolveDomain(cwd);
  if (resolved) return toMailDomain(resolved);

  // Outside every registered domain. Only safe when there is nothing to be outside of.
  if (db.listDomains().length === 0) return UNASSIGNED_MAIL_DOMAIN;

  throw invalidParams(
    `${cwd} is outside every registered domain — name one with -d <domain> (see \`mcx domain ls\`). Mail is not delivered to a guessed domain.`,
  );
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
 * - `user@domain` resolves through the domains table. An unknown domain is an error at
 *   **send** time — the acceptance criterion the issue names — rather than a row written
 *   into a partition nobody reads.
 * - A **cross-domain** send from the unassigned partition is refused. Partition 0 has no
 *   name, so the recipient could not be given a return address, and a reply would be
 *   delivered to a same-named mailbox in the *recipient's* domain instead: silent
 *   misdelivery to a third party. Refusing is the closed direction.
 * - A `sender` may carry `@domain` only if it is the caller's own. Otherwise any caller
 *   could stamp a message as coming from another domain and steer the reply into it.
 *
 * Cross-domain traffic does not become an ambient channel because it is per-message and
 * one-directional: the row lands in the recipient's partition and is readable only there.
 * There is no query anywhere that returns rows from more than one partition, so a domain
 * cannot observe another domain's traffic — only receive a message a named sender chose
 * to address to it.
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
      `cannot send as ${JSON.stringify(senderRaw)} from domain ${JSON.stringify(caller.name ?? "(unassigned)")} — a sender may only be qualified with its own domain`,
    );
  }

  const recipient = parseMailAddress(recipientRaw);
  if (recipient.domain === null) {
    return { domain: caller, recipient: recipient.local, sender: sender.local, crossDomain: false };
  }

  const target = db.getDomainByName(recipient.domain);
  if (!target) {
    throw invalidParams(
      `unknown domain ${JSON.stringify(recipient.domain)} in recipient ${JSON.stringify(recipientRaw)} — register it with \`mcx domain add\` (see \`mcx domain ls\`)`,
    );
  }

  if (target.id === caller.id) {
    return { domain: caller, recipient: recipient.local, sender: sender.local, crossDomain: false };
  }

  if (caller.name === null) {
    throw invalidParams(
      `cannot send to ${JSON.stringify(recipientRaw)} from outside every domain: the message would have no return address. Register this path with \`mcx domain add\`, or name your domain with -d <domain>.`,
    );
  }

  return {
    domain: toMailDomain(target),
    recipient: recipient.local,
    sender: formatMailAddress({ local: sender.local, domain: caller.name }),
    crossDomain: true,
  };
}
