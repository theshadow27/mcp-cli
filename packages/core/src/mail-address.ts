/**
 * Mail addressing — `user`, `user@domain`, and the unassigned partition (#3038).
 *
 * A mail address is a local part (the mailbox role-name: `orchestrator`, `boss`, `*`)
 * and an optional domain. The rules live here as pure functions rather than inlined at
 * the call sites that need them, because "where does a bare name go" is exactly the kind
 * of question that gets answered differently in two places and then quietly delivers
 * mail into the wrong partition.
 *
 * ## The split rule
 *
 * The split is on the **last** `@`, which is the rule #3038 pins explicitly. Splitting
 * on the *first* `@` would reinterpret `claude-a@b` in domain `c` as `claude-a` in the
 * (invalid) domain `b@c`.
 *
 * ## Why a local part may not itself contain `@`
 *
 * Splitting on the last `@` is deterministic, but it is **not** sufficient on its own,
 * and the gap was a live exfiltration channel rather than a cosmetic one:
 *
 *     sender "evil@beta@alpha" from domain alpha
 *       -> local "evil@beta", domain "alpha"     — suffix is the caller's OWN domain,
 *                                                  so a spoof check on the domain passes
 *       -> stored bare as "evil@beta"            — crossDomain false; looks purely local
 *       -> victim replies to "evil@beta"         — which re-parses as evil AT beta
 *       -> the reply body leaves alpha           — and neither party ever typed user@domain
 *
 * The root cause is that `evil@beta` does not **round-trip**: parsing it yields something
 * other than itself. So the invariant is not "split correctly", it is:
 *
 * > A stored address must re-parse to the address that was stored.
 *
 * The cheapest total way to guarantee that is to forbid `@` in a local part. The split
 * rule stays exactly as pinned — `a@b@c` still parses deterministically to local `a@b`,
 * domain `c` — and is then **rejected** as an invalid address. Rejecting after a
 * deterministic parse is deliberate: it makes the refusal explicit rather than an
 * accident of where the string happened to divide.
 */

import { isValidDomainName } from "./domain";

/**
 * The reserved domain name for the unassigned partition (`domain_id = 0`).
 *
 * Partition 0 is a real partition — it holds every row written before any domain was
 * resolved, which on an existing install is the entire mail history. It therefore needs
 * a name, or it is data with no address: unreachable by `-d`, unreachable by
 * `user@domain`, and unable to appear as a return address on a message it sent.
 *
 * `_` is chosen because {@link isValidDomainName} **rejects** it (a domain name must
 * start alphanumeric), so `mcx domain add _ …` cannot create a real domain that shadows
 * it. The reservation is enforced by construction rather than by a check somebody has to
 * remember — and `_` already marks the reserved namespace in this codebase (`_mail`,
 * `_work_items`, `_metrics`, `_spans`).
 */
export const UNASSIGNED_DOMAIN_NAME = "_";

/** True when `name` addresses the unassigned partition rather than a row in `domains`. */
export function isUnassignedDomainName(name: string): boolean {
  return name === UNASSIGNED_DOMAIN_NAME;
}

/**
 * True when `name` may appear as the domain half of a mail address: either a real domain
 * name, or the reserved name for the unassigned partition.
 */
export function isAddressableDomainName(name: string): boolean {
  return isUnassignedDomainName(name) || isValidDomainName(name);
}

/** A parsed mail address. `domain === null` means "unqualified" — not "any domain". */
export interface MailAddress {
  /** The mailbox role-name. Never empty, and never contains `@`. */
  local: string;
  /** The domain half, or `null` when the address was bare. Never empty when present. */
  domain: string | null;
}

/**
 * Parse `user` or `user@domain`, splitting on the **last** `@`.
 *
 * Throws — never returns a partially-understood address — when the local part is empty
 * or contains `@`, when the domain half is empty, or when the domain half is neither a
 * legal domain name nor {@link UNASSIGNED_DOMAIN_NAME}. A malformed address that parsed
 * to *something* would be delivered somewhere, and "somewhere" is how a partition leaks.
 */
export function parseMailAddress(raw: string): MailAddress {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("mail address is empty");
  }

  const at = trimmed.lastIndexOf("@");
  if (at === -1) {
    return { local: assertLocalPart(trimmed, raw), domain: null };
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
  if (!isAddressableDomainName(domain)) {
    throw new Error(
      `mail address ${JSON.stringify(raw)} has an invalid domain ${JSON.stringify(domain)} (domain names are alphanumeric, hyphen and underscore, starting with alphanumeric; "${UNASSIGNED_DOMAIN_NAME}" addresses the unassigned partition)`,
    );
  }

  return { local: assertLocalPart(local, raw), domain };
}

/**
 * A local part must not contain `@`, so that every stored address re-parses to itself.
 * See the exfiltration walk-through in this module's header.
 */
function assertLocalPart(local: string, raw: string): string {
  if (local.includes("@")) {
    throw new Error(
      `mail address ${JSON.stringify(raw)} has "@" in its local part ${JSON.stringify(local)} — a mailbox name may not contain "@", because such an address would not re-parse to itself and a reply to it would cross a domain boundary neither party asked for`,
    );
  }
  return local;
}

/** Render an address back to the form {@link parseMailAddress} accepts. */
export function formatMailAddress(address: MailAddress): string {
  return address.domain === null ? address.local : `${address.local}@${address.domain}`;
}
