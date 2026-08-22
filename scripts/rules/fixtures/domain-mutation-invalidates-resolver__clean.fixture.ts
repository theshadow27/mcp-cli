/**
 * @rule domain-mutation-invalidates-resolver
 * @expect 0
 * @path packages/daemon/src/handlers/domain.ts
 *
 * The same handler, pairing each mutation with an invalidate. No violations.
 */

declare const db: {
  createDomain(name: string, path: string): { id: number };
  renameDomain(from: string, to: string): boolean;
};
declare const domains: { invalidate(): void };

export function addDomain(name: string, path: string): number {
  const domain = db.createDomain(name, path);
  domains.invalidate();
  return domain.id;
}

export function rename(from: string, to: string): boolean {
  const ok = db.renameDomain(from, to);
  domains.invalidate();
  return ok;
}
