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
 * - `wide` — the command already reads *every* domain when `-d` is absent, and says so in
 *   its own help. There is no guess to remove: an omitted `-d` is a documented answer, not a
 *   missing one. `-d` still narrows, and an unknown name is still an error, but the
 *   outside-every-domain refusal does not apply. Ignoring this distinction regressed
 *   `mcx monitor` from a cron job into a hard failure (#3391 review).
 */
export type DomainScopeKind = "named" | "ambient" | "wide";

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
/**
 * `ls` and its long spelling. `CLAUDE_SUB_ALIASES` maps `list` → `ls` before dispatch, so a
 * guard that matched only the short one left `mcx claude list` unclassified — the same
 * command, unguarded, under its other name (#3391 review).
 */
function isListVerb(sub: string | undefined): boolean {
  return sub === "ls" || sub === "list";
}

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

    // monitor_events — `-d` is the reference implementation this issue generalizes, and its
    // documented default ("omit to see every domain") is the reason `wide` exists. `monitor`
    // has never scoped by domain without `-d`; it scopes by `--repo`, which is a separate
    // axis and untouched here.
    case "monitor":
      return "wide";

    // agent_sessions. Only the listing verbs are scoped: every other agent verb takes an
    // explicit session id, where a domain would add nothing but a way to get it wrong.
    // `--all` is the documented machine-wide escape and is handled by the caller.
    case "claude":
      return isListVerb(sub) ? "named" : null;
    case "agent":
      // `mcx agent <provider> ls`
      return isListVerb(third) ? "named" : null;
    // Deprecated `mcx <provider> …` spellings still route to cmdAgent, so they inherit it.
    case "codex":
    case "acp":
    case "copilot":
    case "gemini":
    case "opencode":
    case "grok":
      return isListVerb(sub) ? "named" : null;

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
 * Commands that print their usage when handed no arguments at all (`mcx phase`, `mcx alias`,
 * `mcx track`). `tracked`, `mail` and `aliases` are absent on purpose: bare, they are real
 * commands that read rows — `mcx aliases` dispatches to `alias ls`.
 */
const BARE_IS_HELP = new Set(["track", "untrack", "phase", "alias"]);

/**
 * Commands that additionally spell help as a bare subcommand (`mcx phase help`). The
 * shorthands are absent because their argv is rewritten before dispatch: `mcx aliases help`
 * becomes `alias ls help`, and `mcx save help` saves an alias called "help".
 */
const HELP_SUBCOMMAND = new Set(["phase", "alias"]);

/**
 * True when `args` asks for help rather than for work.
 *
 * `--help`/`-h` count anywhere — that is `hasHelpFlag`'s contract everywhere else in the
 * CLI, and `mcx tracked --phase qa --help` is a help request. A *bare* `help` counts only in
 * the subcommand slot, and only for the commands that actually implement that spelling.
 *
 * The earlier version scanned the whole list for the bare token, so any argument that
 * happened to be the word "help" — a `--meta` value, a branch name — turned the guard off:
 * `cd /tmp && mcx track 42 help` wrote to partition 0 with no refusal, which is precisely
 * the silent fallback #3036 exists to close (#3391 review).
 */
function isHelpRequest(command: string, args: readonly string[]): boolean {
  if (args.includes("--help") || args.includes("-h")) return true;
  if (args.length === 0) return BARE_IS_HELP.has(command);
  return args[0] === "help" && HELP_SUBCOMMAND.has(command);
}

/**
 * Commands whose `--all` is a *documented* machine-wide escape: the read-only session
 * listings, where "every session on this box" is a supported question.
 *
 * `track`/`untrack`/`tracked`/`mail` define no such flag, so honouring `--all` for them was
 * a bypass and not an escape — `cd /tmp && mcx untrack 555 --all` ran unguarded against the
 * unassigned partition, a real and populated one (#3391 review).
 */
const MACHINE_WIDE_ESCAPE = new Set(["claude", "agent", "codex", "acp", "copilot", "gemini", "opencode", "grok"]);

/** The documented machine-wide escape on the session listings. `-d` has already been removed. */
function isExplicitlyMachineWide(command: string, rest: readonly string[]): boolean {
  if (!MACHINE_WIDE_ESCAPE.has(command)) return false;
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
 * Returns the argument list `main.ts` should dispatch with — `argv` unchanged for every
 * invocation that is not domain-scoped, so `main.ts` can call it unconditionally.
 *
 * The one case where the returned list differs is a *validated* `-d` on an `ambient`
 * command, where the flag is by definition a no-op (it can only name the domain the command
 * is already in) and is therefore removed. `phase`'s and `alias`'s own parsers are strict and
 * do not declare `-d`, so leaving it in place made `mcx phase run impl -d <this-domain>` die
 * with `unknown flag: -d` — i.e. `-d` never succeeded on the two ambient commands that
 * mutate state, while the guard's own tests, which only ever called this function, called it
 * a harmless no-op (#3391 review). The `named` and `wide` commands parse `-d` themselves and
 * get their argv back untouched.
 *
 * `argv` is the post-global-flag argument list, command first (`["tracked", "--json"]`).
 */
export async function requireDomainScope(argv: readonly string[], deps: DomainGuardDeps): Promise<string[]> {
  const passthrough = [...argv];

  // `-d` comes off BEFORE classification. Reading fixed argv slots for the subcommand meant
  // a flag placed ahead of it (`mcx claude -d phoenix ls`) left `sub` as `"-d"` and the
  // invocation classified as unguarded (#3391 review).
  const { domain, rest: positional, error } = extractDomainFlag(passthrough);
  const [command, sub, third] = positional;
  const kind = scopeKindFor(command, sub, third);
  if (kind === null || command === undefined) return passthrough;

  const args = positional.slice(1);
  if (isHelpRequest(command, args)) return passthrough;

  if (error) {
    deps.error(error);
    return deps.exit(1);
  }
  if (domain === undefined) {
    // A command that already reads every domain has nothing to resolve and nothing to
    // refuse; skipping the round trip keeps `mcx monitor` exactly as it shipped.
    if (kind === "wide") return passthrough;
    if (isExplicitlyMachineWide(command, args)) return passthrough;
  }

  // One round trip answers both questions: which domain owns $PWD, and what is registered.
  // Asked even when `-d` was given, because "unknown domain" has to be able to say what IS
  // known — an error that only says "no" is the reason `mcx domain which` reports both.
  const { domain: ambient, registered } = await deps.ipcCall("domainWhich", { path: deps.cwd() });

  if (domain !== undefined) {
    // `_` names partition 0 on purpose and resolves without a row — but it is validated
    // here, alongside every other name, rather than in an early return placed above the
    // `ambient` check. That early return let `mcx phase show impl -d _` and `mcx alias ls
    // -d _` skip the guard entirely from outside every registered domain (#3391 review).
    if (!isUnassignedDomainName(domain) && !registered.includes(domain)) {
      deps.error(`Unknown domain "${domain}".`);
      deps.error(formatRegistered(registered));
      deps.error(
        `Register it with \`mcx domain add ${domain} <path>\`, or use "${UNASSIGNED_DOMAIN_NAME}" for the unassigned partition.`,
      );
      return deps.exit(1);
    }
    if (kind === "ambient") {
      if (domain !== ambient?.name) {
        // Not a scoping failure but a category error, and it gets its own message: this
        // command reads THIS checkout's `.mcx.yaml`, lockfile and scripts, so pointing it at
        // another domain's name would run local code and report it as that domain's.
        // Silently honouring the flag for the partition key while the files came from here
        // is exactly the half-scoped write this issue exists to remove. `_` lands here too:
        // partition 0 is not this checkout either.
        deps.error(`\`mcx ${command}\` acts on the repository in $PWD, so -d ${domain} cannot redirect it.`);
        deps.error(
          isUnassignedDomainName(domain)
            ? `"${UNASSIGNED_DOMAIN_NAME}" is a partition, not a checkout — there is no repository there for it to act on.`
            : `Run it from inside "${domain}" instead: cd to that domain and re-run.`,
        );
        return deps.exit(1);
      }
      // Validated, and it named the domain the command is already in — a no-op. Hand back
      // an argv without it, because the ambient commands' parsers do not declare `-d`.
      return positional;
    }
    return passthrough;
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
  if (registered.length === 0) return passthrough;

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

  return passthrough;
}

/** Exported for the spec: the classification is the part worth pinning per surface. */
export const _scopeKindFor = scopeKindFor;
