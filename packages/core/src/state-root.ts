/**
 * The `repo_root` half of an `alias_state` key: its sentinel, its validator, and its
 * canonicalizer.
 *
 * A leaf module on purpose. `ipc.ts` validates this field on the wire and `alias-state.ts`
 * derives it, and `alias-state.ts` → `ipc-client.ts` → `ipc.ts` is already an import chain
 * — so the three had to live below all of them or the sentinel would have had to be
 * spelled twice, which is exactly the failure #3209 is about.
 */

import { isAbsolute, resolve } from "node:path";
import { resolveRealpath } from "./fs";

/** Sentinel repo_root used when the caller is not inside a git repository. */
export const NO_REPO_ROOT = "__none__";

/**
 * Whether a caller-supplied `repo_root` is a legal `alias_state` key half: an absolute
 * path, or the {@link NO_REPO_ROOT} sentinel.
 *
 * Relative paths are rejected because `resolve()` would silently key them to the
 * *daemon's* cwd — a partition the caller never named and cannot predict (#1525/#1917).
 * The sentinel is not a relative path in disguise; it is the key `ctx.state` uses for
 * every caller that is not in a repo, so rejecting it made `ctx.state` unusable there
 * (a ZodError out of `AliasStateScope`, since #1917) while `phase_state_*` rejected it
 * with `"repoRoot must be an absolute path"` — both for the one root that was correct.
 */
export function isValidStateRoot(raw: string): boolean {
  return raw === NO_REPO_ROOT || isAbsolute(raw);
}

/**
 * Canonicalize a caller-supplied `repo_root` to the exact string stored in the
 * `repo_root` column — **including when it is the {@link NO_REPO_ROOT} sentinel.**
 *
 * Every daemon-side entry point must funnel through this. `NO_REPO_ROOT` was documented
 * as a sentinel but was not one on the wire (#3376): the four `aliasState*` IPC handlers
 * each did `resolveRealpath(resolve(repoRoot))`, and `resolve("__none__")` is
 * `<daemon-cwd>/__none__` — a real, daemon-cwd-relative path that may even fall inside a
 * registered domain. Meanwhile the daemon's own automation reader passes the sentinel
 * straight to `db.listAliasState`. One nominal key, two rows, depending on which door it
 * came through — the same split store #3209 exists to close, one layer down.
 *
 * The sentinel is deliberately not path-shaped, so it can never collide with a real root.
 */
export function normalizeStateRoot(raw: string): string {
  return raw === NO_REPO_ROOT ? NO_REPO_ROOT : resolveRealpath(resolve(raw));
}
