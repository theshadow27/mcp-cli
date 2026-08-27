import { describe, expect, test } from "bun:test";
import type { Domain, DomainWhichResult, IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { type DomainGuardDeps, _scopeKindFor, requireDomainScope } from "./domain-guard";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const PHOENIX: Domain = {
  id: 1,
  name: "phoenix",
  host: null,
  path: "/srv/phoenix",
  createdAt: "2026-08-26T00:00:00.000Z",
};

interface Harness {
  deps: DomainGuardDeps;
  calls: Array<{ method: IpcMethod; params: unknown }>;
  stderr: string[];
}

/**
 * `which` is the whole daemon surface the guard uses: it answers "which domain owns $PWD"
 * and "what is registered" in one call, which is why an unknown-domain error can name the
 * alternatives without a second round trip.
 */
function harness(which: DomainWhichResult, cwd = "/srv/phoenix/pkg"): Harness {
  const calls: Array<{ method: IpcMethod; params: unknown }> = [];
  const stderr: string[] = [];
  return {
    calls,
    stderr,
    deps: {
      ipcCall: (async <M extends IpcMethod>(method: M, params?: unknown) => {
        calls.push({ method, params });
        return which as IpcMethodResult[M];
      }) as DomainGuardDeps["ipcCall"],
      cwd: () => cwd,
      error: (msg) => {
        stderr.push(msg);
      },
      exit: (code) => {
        throw new ExitError(code);
      },
    },
  };
}

const INSIDE: DomainWhichResult = { domain: PHOENIX, registered: ["phoenix", "mcp-cli"] };
const OUTSIDE: DomainWhichResult = { domain: null, registered: ["phoenix", "mcp-cli"] };
const OUTSIDE_LONE: DomainWhichResult = { domain: null, registered: ["phoenix"] };
const OUTSIDE_NONE: DomainWhichResult = { domain: null, registered: [] };

/** Every argv in the issue's surface table, one per row, with its expected classification. */
const NAMED_SURFACES: ReadonlyArray<readonly string[]> = [
  ["track", "42"],
  ["tracked"],
  ["untrack", "42"],
  ["mail", "read"],
  ["claude", "ls"],
  ["claude", "list"],
  ["agent", "codex", "ls"],
];

/**
 * `monitor` reads every domain when `-d` is absent and says so in its own help. There is no
 * guess to remove, so there is nothing to refuse — see the `wide` kind.
 */
const WIDE_SURFACES: ReadonlyArray<readonly string[]> = [["monitor"], ["monitor", "--json"]];

const AMBIENT_SURFACES: ReadonlyArray<readonly string[]> = [
  ["phase", "run", "impl"],
  ["phase", "show", "impl"],
  ["phase", "advance"],
  ["alias", "ls"],
  ["alias", "rm", "foo"],
  ["aliases"],
  ["save", "foo"],
];

const ALL_SURFACES = [...NAMED_SURFACES, ...AMBIENT_SURFACES];

/** Assert the guard refused, and hand back the exit code so the caller can pin it. */
async function expectExit(fn: () => Promise<unknown>): Promise<number> {
  let caught: unknown;
  await fn().catch((err: unknown) => {
    caught = err;
  });
  // Not `.rejects.toThrow()`: a guard that returns normally must fail loudly here rather
  // than let the caller's stderr assertions run against an empty array and pass by accident.
  expect(caught).toBeInstanceOf(ExitError);
  return (caught as ExitError).code;
}

describe("scope classification", () => {
  test.each(NAMED_SURFACES.map((argv) => [argv.join(" "), argv] as const))(
    "`mcx %s` is domain-scoped and can be redirected by name",
    (_label, argv) => {
      expect(_scopeKindFor(argv[0], argv[1], argv[2])).toBe("named");
    },
  );

  test.each(AMBIENT_SURFACES.map((argv) => [argv.join(" "), argv] as const))(
    "`mcx %s` is domain-scoped but acts on $PWD's repository",
    (_label, argv) => {
      expect(_scopeKindFor(argv[0], argv[1], argv[2])).toBe("ambient");
    },
  );

  test.each(WIDE_SURFACES.map((argv) => [argv.join(" "), argv] as const))(
    "`mcx %s` already reads every domain, so -d narrows rather than being required",
    (_label, argv) => {
      expect(_scopeKindFor(argv[0], argv[1], argv[2])).toBe("wide");
    },
  );

  // The exemptions are as load-bearing as the inclusions: `mcx domain add` is how a domain
  // comes to exist, so requiring one would deadlock the recovery path for the whole epic.
  test.each([
    [["domain", "add"]],
    [["domain", "which"]],
    [["call", "github"]],
    [["ls"]],
    [["status"]],
    [["auth", "login"]],
    // Agent verbs that take an explicit session id are not scoped — a domain would add
    // nothing but a way to get it wrong.
    [["claude", "bye"]],
    [["claude", "send"]],
    [["agent", "codex", "bye"]],
    // `phase install`/`check`/`log` touch the lockfile and the manifest, not a domain table.
    [["phase", "install"]],
    [["phase", "check"]],
  ])("%p is not domain-scoped", (argv) => {
    expect(_scopeKindFor(argv[0], argv[1], argv[2])).toBeNull();
  });
});

describe("inside a registered domain", () => {
  test.each(ALL_SURFACES.map((argv) => [argv.join(" "), argv] as const))(
    "`mcx %s` resolves with no -d and is allowed through",
    async (_label, argv) => {
      const h = harness(INSIDE);
      await requireDomainScope(argv, h.deps);
      expect(h.stderr).toEqual([]);
      expect(h.calls).toEqual([{ method: "domainWhich", params: { path: "/srv/phoenix/pkg" } }]);
    },
  );

  test("-d naming a DIFFERENT domain is honoured by a `named` command", async () => {
    const h = harness(INSIDE);
    await requireDomainScope(["tracked", "-d", "mcp-cli"], h.deps);
    expect(h.stderr).toEqual([]);
  });

  // The ambient half of the same case: `mcx phase run` reads THIS checkout's .mcx.yaml,
  // lockfile and scripts, so honouring `-d other` for the partition key while the files came
  // from here would be a half-scoped write — the exact class this issue removes.
  test("-d naming a different domain is REFUSED by an `ambient` command", async () => {
    const h = harness(INSIDE);
    const code = await expectExit(() => requireDomainScope(["phase", "run", "impl", "-d", "mcp-cli"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain("acts on the repository in $PWD");
    expect(h.stderr.join("\n")).toContain("cd to that domain");
  });

  // "Harmless no-op" was true of THIS function and false of the CLI: `phase.ts` and
  // `alias.ts` parse strictly and declare no `-d`, so leaving the flag in argv made
  // `mcx phase run impl -d <this-domain>` die with `unknown flag: -d` — and since `-d
  // <other>` is refused by design, `-d` never succeeded at all on the two ambient commands
  // that mutate state (#3391 review). The guard now hands back the argv to dispatch with.
  test.each([
    [
      ["phase", "run", "impl", "-d", "phoenix"],
      ["phase", "run", "impl"],
    ],
    [
      ["phase", "advance", "--to", "qa", "--domain", "phoenix"],
      ["phase", "advance", "--to", "qa"],
    ],
    [
      ["alias", "ls", "--domain=phoenix"],
      ["alias", "ls"],
    ],
    // Before the subcommand, too: the flag is removed by position-aware parsing, not by
    // hoping it sits at the end.
    [
      ["phase", "-d", "phoenix", "show", "impl"],
      ["phase", "show", "impl"],
    ],
  ])("%p strips the validated no-op -d and dispatches %p", async (argv, expected) => {
    const h = harness(INSIDE);
    expect(await requireDomainScope(argv, h.deps)).toEqual(expected);
    expect(h.stderr).toEqual([]);
  });

  // The mirror of the above: a `named` command parses `-d` itself, so it must get it back.
  test.each([[["tracked", "-d", "mcp-cli"]], [["track", "42", "--domain", "phoenix"]], [["monitor", "-d", "phoenix"]]])(
    "%p keeps its -d — the command parses it itself",
    async (argv) => {
      const h = harness(INSIDE);
      expect(await requireDomainScope(argv, h.deps)).toEqual(argv);
      expect(h.stderr).toEqual([]);
    },
  );

  // `mcx claude -d phoenix ls` classified as unguarded because `sub` was read from a fixed
  // argv slot and found `-d` there (#3391 review).
  test("a -d placed before the subcommand still classifies the command", async () => {
    const h = harness(INSIDE);
    const code = await expectExit(() => requireDomainScope(["claude", "-d", "nope", "ls"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain('Unknown domain "nope"');
  });
});

describe("outside every registered domain", () => {
  // The point of the whole issue, asserted once per surface so a later slice inherits the
  // behaviour rather than inventing its own.
  test.each(ALL_SURFACES.map((argv) => [argv.join(" "), argv] as const))(
    "`mcx %s` exits non-zero, names the registered domains, and calls nothing else",
    async (_label, argv) => {
      const h = harness(OUTSIDE, "/tmp");
      const code = await expectExit(() => requireDomainScope(argv, h.deps));
      expect(code).toBe(1);
      const said = h.stderr.join("\n");
      expect(said).toContain("/tmp is not inside any registered domain");
      expect(said).toContain("Registered domains: phoenix, mcp-cli");
      // Nothing but the read-only lookup ran: no row was written before the refusal.
      expect(h.calls.map((c) => c.method)).toEqual(["domainWhich"]);
    },
  );

  // A guess that is right nine times out of ten is worse than an error, because the tenth
  // writes into another project's tables. One registered domain is the most tempting case.
  test("with exactly ONE domain registered, it still errors rather than picking it", async () => {
    const h = harness(OUTSIDE_LONE, "/tmp");
    const code = await expectExit(() => requireDomainScope(["track", "42"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain("Registered domains: phoenix");
    expect(h.stderr.join("\n")).not.toContain("phoenix is the only");
  });

  // The carve-out is for the PREMISE, not the rule. With zero domains there is exactly one
  // partition and every row on the box already lives in it, so there is no wrong partition
  // to land in — and refusing would brick a fresh install for a box with no interest in
  // domains. Contrast the one-domain case directly above, which stays an error.
  test("with NO domains registered at all, the rule does not apply", async () => {
    const h = harness(OUTSIDE_NONE, "/tmp");
    await requireDomainScope(["tracked"], h.deps);
    expect(h.stderr).toEqual([]);
  });

  test("registering the FIRST domain is what turns the rule on", async () => {
    const before = harness(OUTSIDE_NONE, "/tmp");
    await requireDomainScope(["track", "42"], before.deps);
    expect(before.stderr).toEqual([]);

    const after = harness(OUTSIDE_LONE, "/tmp");
    expect(await expectExit(() => requireDomainScope(["track", "42"], after.deps))).toBe(1);
  });

  // The carve-out is for the default-resolution half only. A name that does not exist is
  // still a typo, and reporting it does not depend on any domain being registered.
  test("an unknown -d is still an error when no domains are registered", async () => {
    const h = harness(OUTSIDE_NONE, "/tmp");
    const code = await expectExit(() => requireDomainScope(["tracked", "-d", "phoenex"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain('Unknown domain "phoenex"');
    expect(h.stderr.join("\n")).toContain("No domains are registered");
  });

  test("a `named` command with an explicit -d is allowed through", async () => {
    const h = harness(OUTSIDE, "/tmp");
    await requireDomainScope(["tracked", "-d", "phoenix"], h.deps);
    expect(h.stderr).toEqual([]);
  });

  // Partition 0 is where every pre-domain row lives, so it is addressable on purpose —
  // by the same `_` spelling mail accepts, not by omitting the flag.
  test('-d "_" addresses the unassigned partition from outside every domain', async () => {
    const h = harness(OUTSIDE, "/tmp");
    await requireDomainScope(["mail", "read", "-d", "_"], h.deps);
    expect(h.stderr).toEqual([]);
  });

  test("an `ambient` command with -d is still refused — it cannot be redirected", async () => {
    const h = harness(OUTSIDE, "/tmp");
    const code = await expectExit(() => requireDomainScope(["phase", "run", "impl", "-d", "phoenix"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain("acts on the repository in $PWD");
  });

  // `_` used to be handled by an early return placed ABOVE the ambient check, so it skipped
  // the whole guard: `mcx phase show impl -d _` and `mcx alias ls -d _` ran normally from a
  // checkout outside every registered domain (#3391 review). Partition 0 is a partition, not
  // a checkout — there is no repository there for an ambient command to act on.
  test.each([
    [["phase", "show", "impl", "-d", "_"]],
    [["phase", "run", "impl", "-d", "_"]],
    [["alias", "ls", "-d", "_"]],
  ])("%p is refused: the unassigned partition is not a checkout", async (argv) => {
    const h = harness(OUTSIDE, "/tmp");
    const code = await expectExit(() => requireDomainScope(argv, h.deps));
    expect(code).toBe(1);
    const said = h.stderr.join("\n");
    expect(said).toContain("acts on the repository in $PWD");
    expect(said).toContain("is a partition, not a checkout");
  });

  // `-d _` from INSIDE a domain is the same category error — the flag still cannot redirect
  // an ambient command, and partition 0 is not where its files are.
  test("an `ambient` -d _ is refused from inside a domain too", async () => {
    const h = harness(INSIDE);
    expect(await expectExit(() => requireDomainScope(["alias", "ls", "-d", "_"], h.deps))).toBe(1);
  });

  // The regression this guard must NOT cause: `mcx monitor` without `-d` has always meant
  // "every domain" (its own help says so), so a cron job that streams events from outside a
  // checkout is a supported use, not a missing scope (#3391 review).
  test.each(WIDE_SURFACES.map((argv) => [argv.join(" "), argv] as const))(
    "`mcx %s` is allowed from outside every domain and asks the daemon nothing",
    async (_label, argv) => {
      const h = harness(OUTSIDE, "/tmp");
      expect(await requireDomainScope(argv, h.deps)).toEqual([...argv]);
      expect(h.stderr).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  );

  // `wide` relaxes the *absence* of `-d`, not its content: a name that does not exist is
  // still a typo that would silently stream the wrong thing.
  test("monitor -d <unknown> is still an error", async () => {
    const h = harness(OUTSIDE, "/tmp");
    const code = await expectExit(() => requireDomainScope(["monitor", "-d", "phoenex"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain('Unknown domain "phoenex"');
  });
});

describe("-d validation", () => {
  test("an unknown domain errors and lists the known ones", async () => {
    const h = harness(INSIDE);
    const code = await expectExit(() => requireDomainScope(["tracked", "-d", "phoenex"], h.deps));
    expect(code).toBe(1);
    const said = h.stderr.join("\n");
    expect(said).toContain('Unknown domain "phoenex"');
    expect(said).toContain("Registered domains: phoenix, mcp-cli");
    expect(said).toContain("mcx domain add phoenex");
  });

  // Inherited from extractDomainFlag's widening guard: a domain name can never start with
  // `-`, so `mcx claude ls -d --all` is a user error and must be reported, never swallowed
  // into the widest possible query.
  test("a bare -d followed by another flag is reported, not swallowed", async () => {
    const h = harness(INSIDE);
    const code = await expectExit(() => requireDomainScope(["claude", "ls", "-d", "--all"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain("--domain requires a domain name");
    // Reported BEFORE the lookup: nothing about the daemon is needed to know this is wrong.
    expect(h.calls).toEqual([]);
  });

  test("--domain=<name> is accepted like the rest of the CLI's long options", async () => {
    const h = harness(OUTSIDE, "/tmp");
    await requireDomainScope(["tracked", "--domain=phoenix"], h.deps);
    expect(h.stderr).toEqual([]);
  });
});

describe("escapes", () => {
  // `--all` is the documented machine-wide listing. It is an explicit request for every
  // domain, so it is not a missing scope — and it must not require one, or the one command
  // that shows you what exists elsewhere would be unusable from outside a domain.
  test.each([[["claude", "ls", "--all"]], [["claude", "ls", "-a"]], [["agent", "codex", "ls", "--all"]]])(
    "%p bypasses the guard without touching the daemon",
    async (argv) => {
      const h = harness(OUTSIDE, "/tmp");
      await requireDomainScope(argv, h.deps);
      expect(h.stderr).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  );

  // `--all` is an escape for a MISSING scope, not an override of an explicit one: with `-d`
  // present the flag was a deliberate narrowing, so the name still has to be real.
  test("--all does not excuse an unknown -d", async () => {
    const h = harness(INSIDE);
    const code = await expectExit(() => requireDomainScope(["claude", "ls", "-d", "nope", "--all"], h.deps));
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain('Unknown domain "nope"');
  });

  // `--all` is not a flag `track`/`untrack`/`tracked`/`mail` declares, so honouring it for
  // them was a bypass and not an escape: `cd /tmp && mcx untrack 555 --all` ran with no
  // refusal against the unassigned partition, which is real and populated (#3391 review).
  test.each([
    [["untrack", "555", "--all"]],
    [["track", "42", "--all"]],
    [["tracked", "--all"]],
    [["mail", "read", "--all"]],
    // `-a` likewise: it is `--agent`'s short form on some providers, and nothing at all here.
    [["track", "42", "-a"]],
  ])("%p is NOT excused by --all — only the session listings define that escape", async (argv) => {
    const h = harness(OUTSIDE, "/tmp");
    expect(await expectExit(() => requireDomainScope(argv, h.deps))).toBe(1);
    expect(h.stderr.join("\n")).toContain("is not inside any registered domain");
  });

  test.each([
    [["track", "--help"]],
    [["tracked", "-h"]],
    [["phase", "run", "--help"]],
    // Not just the first slot: refusing `mcx tracked --phase qa --help` for want of a domain
    // would mean the one command that tells you about -d cannot run where you need telling.
    [["tracked", "--phase", "qa", "--help"]],
    // The bare-`help` subcommand, for the commands that implement that spelling.
    [["phase", "help"]],
    [["alias", "help"]],
    // …and the bare invocation, which is how `mcx phase` and `mcx track` print their usage.
    [["phase"]],
    [["track"]],
    [["alias"]],
  ])("%p is a help request and needs no domain", async (argv) => {
    const h = harness(OUTSIDE, "/tmp");
    await requireDomainScope(argv, h.deps);
    expect(h.stderr).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  // `isHelpRequest` scanned the whole arg list for the bare token `help`, so any argument
  // that happened to be that word turned the guard off entirely: `cd /tmp && mcx track 42
  // help` wrote a row into partition 0 with no refusal (#3391 review, confirmed against the
  // sqlite db). `help` is a subcommand spelling, and only in the subcommand slot.
  test.each([
    [["track", "42", "help"]],
    [["untrack", "42", "help"]],
    [["mail", "send", "boss", "help"]],
    [["tracked", "--phase", "help"]],
    // `mcx track help` is not a spelling `track` implements, so it is not help either.
    [["track", "help"]],
  ])("%p is NOT a help request — the guard still applies", async (argv) => {
    const h = harness(OUTSIDE, "/tmp");
    expect(await expectExit(() => requireDomainScope(argv, h.deps))).toBe(1);
    expect(h.stderr.join("\n")).toContain("is not inside any registered domain");
  });

  test("an unscoped command never asks the daemon anything", async () => {
    const h = harness(OUTSIDE, "/tmp");
    await requireDomainScope(["call", "github", "search"], h.deps);
    expect(h.calls).toEqual([]);
    expect(h.stderr).toEqual([]);
  });
});
