/**
 * Binding a worker to a domain — the validation half, kept out of the worker
 * entrypoint so it can be tested without a thread.
 *
 * The daemon builds an `init` message from the `domains` table, so a malformed
 * one means the link is carrying something other than what the supervisor sent.
 * In-process that is nearly impossible; over a socket it is an ordinary Tuesday,
 * and the failure mode is the worst one available — a worker executing one
 * project's code against another project's path. Hence a parser at the boundary
 * rather than a cast.
 */

import { type DomainSnapshot, isValidDomainName } from "@mcp-cli/core";

/** Thrown when an `init` payload does not describe a domain this worker may serve. */
export class DomainBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainBindError";
  }
}

/**
 * Validate an `init.domain` payload and return it as a {@link DomainSnapshot}.
 *
 * Rejects a remote domain outright: a worker running in this process serves a
 * local domain by definition, and a domain with a `host` is served by a worker
 * on *that* host. Quietly running it here is the "it works because both ends are
 * in one process" defect in its most damaging form.
 */
export function validateDomainSnapshot(value: unknown): DomainSnapshot {
  if (typeof value !== "object" || value === null) throw new DomainBindError("init.domain is missing");
  const d = value as Record<string, unknown>;

  if (typeof d.id !== "number" || !Number.isInteger(d.id) || d.id <= 0) {
    throw new DomainBindError(`init.domain.id must be a positive integer, got ${JSON.stringify(d.id)}`);
  }
  if (typeof d.name !== "string" || !isValidDomainName(d.name)) {
    throw new DomainBindError(`init.domain.name is not a valid domain name: ${JSON.stringify(d.name)}`);
  }
  if (d.host !== null && typeof d.host !== "string") {
    throw new DomainBindError(`init.domain.host must be a string or null, got ${JSON.stringify(d.host)}`);
  }
  if (d.host !== null) {
    throw new DomainBindError(
      `domain "${d.name}" lives on host ${JSON.stringify(d.host)} and cannot be served by a worker in this process`,
    );
  }
  if (typeof d.path !== "string" || d.path.length === 0) {
    throw new DomainBindError(`init.domain.path must be a non-empty string, got ${JSON.stringify(d.path)}`);
  }
  if (typeof d.createdAt !== "string") {
    throw new DomainBindError(`init.domain.createdAt must be a string, got ${JSON.stringify(d.createdAt)}`);
  }

  return { id: d.id, name: d.name, host: null, path: d.path, createdAt: d.createdAt };
}
