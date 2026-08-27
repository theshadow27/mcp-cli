/**
 * "Which domain is this command acting in?" — asked once, before dispatch (#3036).
 *
 * The rule, from `docs/domains.md`:
 *
 * > Commands that act on domain-partitioned state resolve their domain by walking up from
 * > `$PWD` to the nearest registered domain. `-d <name>` overrides. **Outside any
 * > registered domain, `-d` is required and its absence is an error, never a guess.**
 *
 * ## Why a guard, and why here
 *
 * The daemon already resolves a domain per request, and it resolves an unknown path to
 * `NO_DOMAIN_ID` — the unassigned partition. `packages/daemon/src/domain-scope.ts` says why
 * that is right *there*: it is the honest home for daemon-owned state whose owner is
 * genuinely unknown, and every row written before domains existed lives in it.
 *
 * It is exactly wrong for a command a human typed. `mcx track 42` run from `/tmp` would
 * silently land in partition 0 rather than in the project the operator meant, and nothing
 * would report it. A guess that is right nine times out of ten is worse than an error,
 * because the tenth writes into another project's tables. The #3155 audit found two live
 * instances of this class already (#3352, #3353); this is the general rule they are special
 * cases of.
 *
 * So the client half refuses. One guard, called once from `main.ts` before the dispatch
 * switch, rather than a resolution step bolted onto each command — because the failure this
 * prevents is precisely a surface that forgot to bolt one on.
 *
 * ## What this is not
 *
 * It is not a resolver. The domains table lives in the daemon and `resolveDomainForPath` is
 * the only walk-up rule in the codebase; this asks `domainWhich` and reports the answer. It
 * never picks a domain, never falls back to the only registered one, and never falls back to
 * `process.cwd()` when `-d` was given.
 */

import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { UNASSIGNED_DOMAIN_NAME, isUnassignedDomainName } from "@mcp-cli/core";
import { extractDomainFlag } from "./parse";

/**
 * How a command relates to the domain it acts in.
 *
 * - `named` — the command acts on daemon-side rows and can act on *any* domain's, so
 *   `-d <name>` genuinely redirects it. `mcx tracked -d phoenix` from inside `mcp-cli`
 *   lists phoenix's work items.
 * - `ambient` — the command acts on the repository in `$PWD` (it reads `.mcx.yaml`, hashes
 *   local files, runs local scripts), so it must be *inside* a domain, but `-d` naming a
 *   different one cannot redirect it. Accepting such a flag would be the same silent
 *   mis-scope in the other direction: a flag that looks like it scoped the command and did
 *   not. It is therefore an error, with the remedy (`cd`) named.
 */
export type DomainScopeKind = "named" | "ambient";

/**
 * The domain-partitioned CLI surface, enumerated from the schema rather than guessed.
 *
 * Every entry below reaches a table carrying a `domain_id` column:
 *
 * | Command                            | Partitioned state                     |
 * |------------------------------------|---------------------------------------|
 * | `track` / `tracked` / `untrack`    | `work_items`, `work_item_transitions` |
 * | `phase run` / `show` / `advance`   | `work_items`, `alias_state`           |
 * | `mail`                             | `mail`                                |
 * | `claude ls` / `agent <p> ls`       | `agent_sessions`                      |
 * | `alias` (and its `aliases`/`save` shorthands) | `aliases`, `alias_state`    |
 * | `monitor`                          | `monitor_events`                      |
 *
 * `mcx domain` is exempt — it is how you register one, so requiring one would be a deadlock.
 * The non-partitioned surfaces (`call`, `ls`, `status`, `auth`, …) are absent because they
 * reach no `domain_id`, and adding them would be friction with no invariant behind it.
 *
 * **`mcx run <alias>` is deliberately not here.** It reads the `aliases` table by name and so
 * has the same split-brain in principle, but its argument grammar overlaps the `<server>
 * <tool>` shorthand, so classifying an invocation needs more than the first two argv slots.
 * Filed rather than guessed at.
 */
function scopeKindFor(
  command: string | undefined,
  sub: string | undefined,
  third: string | undefined,
): DomainScopeKind | null {
  switch (command) {
    // work_items — a work item lives in a domain, and any domain's can be addressed.
    case "track":
    case "tracked":
    case "untrack":
      return "named";

    // mail — already carries `-d`; the guard adds the outside-every-domain refusal.
    case "mail":
      return "named";

    // monitor_events — `-d` is the reference implementation this issue generalizes.
    case "monitor":
      return "named";

    // agent_sessions. Only the listing verbs are scoped: every other agent verb takes an
    // explicit session id, where a domain would add nothing but a way to get it wrong.
    // `--all` is the documented machine-wide escape and is handled by the caller.
    case "claude":
      return sub === "ls" ? "named" : null;
    case "agent":
      // `mcx agent <provider> ls`
      return third === "ls" ? "named" : null;
    // Deprecated `mcx <provider> …` spellings still route to cmdAgent, so they inherit it.
    case "codex":
    case "acp":
    case "copilot":
    case "gemini":
    case "opencode":
    case "grok":
      return sub === "ls" ? "named" : null;

    // work_items + alias_state, but reached through THIS checkout's `.mcx.yaml` and lockfile.
    case "phase":
      return sub === "run" || sub === "show" || sub === "advance" ? "ambient" : null;

    // aliases + alias_state, keyed on this checkout's files.
    case "alias":
    case "aliases":
    case "save":
      return "ambient";

    default:
      return null;
  }
}

/** Everything the guard needs from the outside world. Injected so it unit-tests without a daemon. */
export interface DomainGuardDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  cwd: () => string;
  error: (msg: string) => void;
  exit: (code: number) => never;
}

/** One line, so every affected command's help can state the rule identically. */
export const DOMAIN_DEFAULT_HELP_LINE =
  "Domain: resolved by walking up from $PWD to the nearest registered domain; -d <name> overrides. Outside every domain, -d is required.";

/**
 * True when `args` asks for help rather than for work.
 *
 * Checked over the *whole* argument list, not just the first slot: `mcx tracked --phase qa
 * --help` is a help request, and refusing it for want of a domain would mean the one command
 * that tells you about `-d` cannot be run from the place where you need to be told.
 */
function isHelpRequest(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args.includes("help");
}

/** The documented machine-wide escape on the session listings. `-d` has already been removed. */
function isExplicitlyMachineWide(rest: readonly string[]): boolean {
  return rest.includes("--all") || rest.includes("-a");
}

function formatRegistered(registered: readonly string[]): string {
  return registered.length > 0
    ? `Registered domains: ${registered.join(", ")}`
    : "No domains are registered. Register one with `mcx domain add <name> <path>`.";
}

/**
 * Refuse a domain-scoped command that cannot say which domain it is acting in.
 *
 * Returns normally — having written nothing and called nothing — for every invocation that
 * is not domain-scoped, so `main.ts` can call it unconditionally.
 *
 * `argv` is the post-global-flag argument list, command first (`["tracked", "--json"]`).
 */
export async function requireDomainScope(argv: readonly string[], deps: DomainGuardDeps): Promise<void> {
  const [command, sub, third] = argv;
  const kind = scopeKindFor(command, sub, third);
  if (kind === null) return;

  const args = argv.slice(1);
  if (isHelpRequest(args)) return;

  const { domain, rest, error } = extractDomainFlag(args);
  if (error) {
    deps.error(error);
    return deps.exit(1);
  }
  if (domain === undefined && isExplicitlyMachineWide(rest)) return;

  // One round trip answers both questions: which domain owns $PWD, and what is registered.
  // Asked even when `-d` was given, because "unknown domain" has to be able to say what IS
  // known — an error that only says "no" is the reason `mcx domain which` reports both.
  const { domain: ambient, registered } = await deps.ipcCall("domainWhich", { path: deps.cwd() });

  if (domain !== undefined) {
    if (isUnassignedDomainName(domain)) return; // partition 0, named on purpose
    if (!registered.includes(domain)) {
      deps.error(`Unknown domain "${domain}".`);
      deps.error(formatRegistered(registered));
      deps.error(
        `Register it with \`mcx domain add ${domain} <path>\`, or use "${UNASSIGNED_DOMAIN_NAME}" for the unassigned partition.`,
      );
      return deps.exit(1);
    }
    if (kind === "ambient" && domain !== ambient?.name) {
      // Not a scoping failure but a category error, and it gets its own message: this
      // command reads THIS checkout's `.mcx.yaml`, lockfile and scripts, so pointing it at
      // another domain's name would run local code and report it as that domain's. Silently
      // honouring the flag for the partition key while the files came from here is exactly
      // the half-scoped write this issue exists to remove.
      deps.error(`\`mcx ${command}\` acts on the repository in $PWD, so -d ${domain} cannot redirect it.`);
      deps.error(`Run it from inside "${domain}" instead: cd to that domain and re-run.`);
      return deps.exit(1);
    }
    return;
  }

  // An install with NO domains at all is not partitioned, and the *default-resolution* half
  // of the rule does not apply to it.
  //
  // A carve-out for the premise, not for the rule — and deliberately placed AFTER the `-d`
  // validation above, so a name that does not exist is still an error here. The hazard this
  // guard exists for is landing in the wrong partition ("the tenth writes into another
  // project's tables"), and that requires a wrong partition to exist. With zero domains there
  // is exactly one, the unassigned one, and every row on the box already lives in it: nothing
  // to guess between, nothing to contaminate. Refusing anyway would be friction with no
  // invariant behind it, and it would brick a fresh install — every command in the table
  // failing until someone ran `mcx domain add`, on a box with no interest in domains at all.
  // `packages/daemon/src/domain-scope.ts` makes the same promise from the other side: "an
  // installation that genuinely has no domains sees no behaviour change."
  //
  // The rule engages the moment a first domain exists — the one-domain case included, which
  // stays an error from outside precisely because partition 0 is then a second, reachable,
  // wrong answer.
  if (registered.length === 0) return;

  if (ambient === null) {
    deps.error(
      `${deps.cwd()} is not inside any registered domain, and \`mcx ${command}\` acts on domain-scoped state.`,
    );
    deps.error(formatRegistered(registered));
    deps.error(
      kind === "named"
        ? `Name one explicitly with -d <domain> (or "${UNASSIGNED_DOMAIN_NAME}" for the unassigned partition), or run from inside a domain.`
        : "Run it from inside a registered domain, or register this one with `mcx domain add <name> .`.",
    );
    return deps.exit(1);
  }
}

/** Exported for the spec: the classification is the part worth pinning per surface. */
export const _scopeKindFor = scopeKindFor;
