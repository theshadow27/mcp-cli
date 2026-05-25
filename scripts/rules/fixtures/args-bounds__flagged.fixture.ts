/**
 * @rule args-bounds
 * @expect 4
 * @path packages/command/src/commands/example.ts
 *
 * Unsafe args[++i] accesses with no bounds guard, no post-check, and no
 * null-coalescing default. Each should be flagged.
 */

declare const args: string[];

export function parseExample(): void {
  let i = 0;
  let scope: string;
  let requestId: string;
  let id: string;

  // 1. Bare assignment, no guard.
  scope = args[++i];

  // 2. Subsequent line checks a different variable.
  requestId = args[++i];
  if (!scope) {
    /* unrelated */
  }

  // 3. Word-boundary mismatch: `id` does not match `requestId`.
  id = args[++i];
  if (requestId === undefined) {
    /* unrelated */
  }

  // 4. `i <= args.length - 1` is off-by-one — does NOT guard the access below.
  if (i <= args.length - 1) {
    scope = args[++i];
  }

  console.log(scope, requestId, id);
}
