/**
 * Mail addressing — `user` and `user@domain` (#3038).
 *
 * A mail address is a local part (the mailbox role-name: `orchestrator`, `boss`, `*`)
 * and an optional domain. The parse rule is pinned here as a pure function rather than
 * inlined at each of the nine call sites that need it, because "where does a bare name
 * go" is exactly the kind of question that gets answered differently in two places and
 * then quietly delivers mail into the wrong partition.
 *
 * The split is on the **last** `@`, which is the rule the issue pins explicitly. Local
 * parts are free-form role-names and a `@` in one is legal (`claude-a@b` is a mailbox);
 * domain names are constrained by {@link isValidDomainName}, so a trailing `@domain`
 * is always unambiguous. Splitting on the *first* `@` would reinterpret the local part
 * `claude-a` in domain `b` as the local part `claude` in the (invalid) domain `a@b`.
 *
 * Resolution — what a bare name *means* — deliberately does not live here. It needs the
 * domains table, so it lives in `packages/daemon/src/mail-domain.ts`. This module only
 * decides where the boundary between the two halves is.
 */

import { isValidDomainName } from "./domain";

/** A parsed mail address. `domain === null` means "unqualified" — not "any domain". */
export interface MailAddress {
  /** The mailbox role-name. Never empty. May itself contain `@`. */
  local: string;
  /** The domain half, or `null` when the address was bare. Never empty when present. */
  domain: string | null;
}

/**
 * Parse `user` or `user@domain`, splitting on the **last** `@`.
 *
 * Throws — never returns a partially-understood address — when the local part is empty,
 * when the domain half is empty, or when the domain half is not a legal domain name.
 * A malformed address that parsed to *something* would be delivered somewhere, and
 * "somewhere" is how a partition leaks.
 */
export function parseMailAddress(raw: string): MailAddress {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("mail address is empty");
  }

  const at = trimmed.lastIndexOf("@");
  if (at === -1) {
    return { local: trimmed, domain: null };
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length === 0) {
    throw new Error(`mail address ${JSON.stringify(raw)} has an empty local part`);
  }
  if (domain.length === 0) {
    throw new Error(
      `mail address ${JSON.stringify(raw)} has an empty domain — drop the trailing "@" to address the local domain`,
    );
  }
  if (!isValidDomainName(domain)) {
    throw new Error(
      `mail address ${JSON.stringify(raw)} has an invalid domain ${JSON.stringify(domain)} (domain names are alphanumeric, hyphen and underscore, starting with alphanumeric)`,
    );
  }

  return { local, domain };
}

/** Render an address back to the form {@link parseMailAddress} accepts. */
export function formatMailAddress(address: MailAddress): string {
  return address.domain === null ? address.local : `${address.local}@${address.domain}`;
}
