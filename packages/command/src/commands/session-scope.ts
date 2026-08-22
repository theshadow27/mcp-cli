/**
 * How a session-listing or session-wait call gets scoped — defined ONCE, for both CLIs.
 *
 * `mcx claude ls` and `mcx agent claude ls` are two front doors onto the same daemon
 * tool, and they have now disagreed about the same flag three separate times: the
 * `--cwd` spawn fallback landed in one and not the other, and then `-d` did the same —
 * `claude.ts` put the `repoRoot` block inside the `else` of the `-d` branch (so an
 * explicit `-d` is a pure domain query) while `agent.ts` made it a sibling (so `-d`
 * silently also narrowed by git root, and the two surfaces returned different answers
 * to the same command).
 *
 * That is not a bug either file can be trusted not to reintroduce, because nothing
 * connects them. So the rule lives here as one function and both callers use it. The
 * duplication being removed is a shared *invariant* — "what does `-d` mean" — not
 * merely similar-looking code.
 *
 * The invariant, stated once:
 *
 *   - `--all`            → no scoping at all.
 *   - `-d <name>`        → a PURE domain query. No `repoRoot`, ever, whatever the
 *                          provider supports. "From anywhere" is what the help text
 *                          promises and it has to be true.
 *   - neither            → scope to the caller's directory (`domainCwd`), and ALSO by
 *                          git root where the provider supports it. Both apply; the
 *                          daemon ANDs them.
 */

import type { LookupResult } from "@mcp-cli/core";
import { isLookupFailure } from "@mcp-cli/core";

export interface SessionScopeInput {
  /** `-d <name>`, if the caller passed one. */
  domain: string | undefined;
  /** True when `--all` was passed — suppresses every filter. */
  all: boolean;
  /** The caller's shell cwd. */
  cwd: string;
  /**
   * Whether this provider supports repo-root scoping (`repoScoped`, Claude-only).
   * Irrelevant on the `-d` path, deliberately — see the invariant above.
   */
  repoScoped: boolean;
  getGitRoot: () => LookupResult<string | null>;
  printError: (message: string) => void;
}

export interface SessionScope {
  /** Scoping arguments to merge into the tool call. */
  args: Record<string, unknown>;
  /** Something to show the user when a filter hid rows, or undefined when nothing scoped. */
  activeFilter: string | undefined;
  /** How to describe what was hidden, for the "use --all to see them" hint. */
  filterLabel: string;
}

/** Build the scoping arguments for a `*_session_list` / `*_wait` call. */
export function buildSessionScope(input: SessionScopeInput): SessionScope {
  if (input.all) {
    return { args: {}, activeFilter: undefined, filterLabel: "other domains or repos" };
  }

  if (input.domain) {
    // A named domain is answered by the domains table alone. Adding `repoRoot` here
    // would AND a second, unrelated predicate onto an explicit request and silently
    // return fewer rows than the user asked for.
    return { args: { domain: input.domain }, activeFilter: input.domain, filterLabel: "other domains" };
  }

  const args: Record<string, unknown> = { domainCwd: input.cwd };
  // `activeFilter` is set even before the git root resolves: the CLI cannot tell
  // whether a domain matched (it has no domains table), but it does know it asked for
  // scoping — which is enough to keep the `--all` hint from vanishing in a non-git
  // directory that happens to be a registered domain.
  let activeFilter: string | undefined = input.cwd;

  if (input.repoScoped) {
    const gitRoot = input.getGitRoot();
    if (isLookupFailure(gitRoot)) {
      input.printError(gitRoot.message);
    } else if (gitRoot) {
      args.repoRoot = gitRoot;
      activeFilter = gitRoot;
    }
  }

  return { args, activeFilter, filterLabel: "other domains or repos" };
}
