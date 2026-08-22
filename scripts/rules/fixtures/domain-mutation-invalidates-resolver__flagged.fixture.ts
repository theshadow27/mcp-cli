/**
 * @rule domain-mutation-invalidates-resolver
 * @expect 2
 * @path packages/daemon/src/handlers/domain.ts
 *
 * An IPC handler that writes the domains table without clearing the resolver memo.
 * After this runs, every path under the new domain still resolves to NO_DOMAIN_ID —
 * silently, with no error, until the daemon restarts. Two violations expected.
 */

declare const db: {
  createDomain(name: string, path: string): { id: number };
  deleteDomain(name: string): boolean;
};

export function addDomain(name: string, path: string): number {
  return db.createDomain(name, path).id;
}

export function removeDomain(name: string): boolean {
  return db.deleteDomain(name);
}
