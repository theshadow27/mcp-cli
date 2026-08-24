import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Domain, IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { type DomainDeps, cmdDomain } from "./domain";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Harness {
  deps: DomainDeps;
  calls: Array<{ method: IpcMethod; params: unknown }>;
  stdout: string[];
  stderr: string[];
}

function domain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: 1,
    name: "phoenix",
    host: null,
    path: "/srv/phoenix",
    createdAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

function harness(results: Partial<Record<IpcMethod, unknown>> = {}, env?: { cwd?: string; home?: string }): Harness {
  const calls: Array<{ method: IpcMethod; params: unknown }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    calls,
    stdout,
    stderr,
    deps: {
      ipcCall: (async <M extends IpcMethod>(method: M, params?: unknown) => {
        calls.push({ method, params });
        const result = results[method];
        if (result instanceof Error) throw result;
        return result as IpcMethodResult[M];
      }) as DomainDeps["ipcCall"],
      exit: (code) => {
        throw new ExitError(code);
      },
      cwd: () => env?.cwd ?? "/home/tester/repo",
      home: () => env?.home ?? "/home/tester",
      log: (msg) => stdout.push(msg),
      error: (msg) => stderr.push(msg),
    },
  };
}

/** `printError` writes straight to console.error; capture it so error text is assertable. */
let consoleErrors: string[] = [];
const realConsoleError = console.error;

beforeEach(() => {
  consoleErrors = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = realConsoleError;
});

/** All stderr the command produced, whichever sink it used. */
function allErrors(h: Harness): string {
  return [...h.stderr, ...consoleErrors].join("\n");
}

describe("mcx domain add", () => {
  test("expands ~ against the caller's home before sending", async () => {
    const h = harness({ domainAdd: domain({ path: "/home/tester/github/phoenix" }) });
    await cmdDomain(["add", "phoenix", "~/github/phoenix"], h.deps);
    expect(h.calls[0]).toEqual({
      method: "domainAdd",
      params: { name: "phoenix", host: null, path: "/home/tester/github/phoenix" },
    });
  });

  test("resolves a relative path against the caller's cwd", async () => {
    const h = harness({ domainAdd: domain() }, { cwd: "/work/repo" });
    await cmdDomain(["add", "here", "."], h.deps);
    expect(h.calls[0].params).toEqual({ name: "here", host: null, path: "/work/repo" });
  });

  test("host:path is the same command — it only splits out the host", async () => {
    const h = harness({ domainAdd: domain({ host: "boxen0010", path: "~/github/phoenix" }) });
    await cmdDomain(["add", "phoenix", "boxen0010:~/github/phoenix"], h.deps);
    expect(h.calls[0].params).toEqual({
      name: "phoenix",
      host: "boxen0010",
      // Verbatim: `~` on another host is that host's home.
      path: "~/github/phoenix",
    });
  });

  test("reports the registration on stderr, leaving stdout clean", async () => {
    const h = harness({ domainAdd: domain({ host: "boxen0010", path: "~/p" }) });
    await cmdDomain(["add", "phoenix", "boxen0010:~/p"], h.deps);
    expect(h.stdout).toEqual([]);
    expect(allErrors(h)).toContain("boxen0010:~/p");
  });

  test("refuses ~user without calling the daemon", async () => {
    const h = harness();
    await expect(cmdDomain(["add", "x", "~alice/work"], h.deps)).rejects.toThrow(ExitError);
    expect(h.calls).toEqual([]);
  });

  test("requires both a name and a location", async () => {
    const h = harness();
    await expect(cmdDomain(["add", "onlyname"], h.deps)).rejects.toThrow(ExitError);
    expect(h.calls).toEqual([]);
  });
});

describe("mcx domain ls", () => {
  test("--json prints the rows to stdout", async () => {
    const rows = [domain(), domain({ id: 2, name: "work", host: "boxen0010", path: "~/work" })];
    const h = harness({ domainList: rows });
    await cmdDomain(["ls", "--json"], h.deps);
    expect(JSON.parse(h.stdout.join("\n"))).toEqual(rows);
  });

  test("renders host:path for a host-bound domain", async () => {
    const h = harness({ domainList: [domain({ host: "boxen0010", path: "~/work" })] });
    await cmdDomain(["ls"], h.deps);
    expect(h.stdout.join("\n")).toContain("boxen0010:~/work");
  });

  test("says so when nothing is registered", async () => {
    const h = harness({ domainList: [] });
    await cmdDomain(["ls"], h.deps);
    expect(h.stdout).toEqual([]);
    expect(allErrors(h)).toContain("No domains registered");
  });
});

describe("mcx domain show", () => {
  test("renders host and path back in the [host:]path form add accepts", async () => {
    const h = harness({ domainShow: domain({ host: "boxen0010", path: "~/github/phoenix" }) });
    await cmdDomain(["show", "phoenix"], h.deps);
    expect(h.stdout.join("\n")).toContain("boxen0010:~/github/phoenix");
  });

  test("exits non-zero for an unknown domain", async () => {
    const h = harness({ domainShow: null });
    await expect(cmdDomain(["show", "ghost"], h.deps)).rejects.toThrow(ExitError);
    expect(allErrors(h)).toContain('No domain named "ghost"');
  });
});

describe("mcx domain which", () => {
  test("defaults to $PWD", async () => {
    const h = harness({ domainWhich: { domain: domain(), registered: ["phoenix"] } }, { cwd: "/srv/phoenix/sub" });
    await cmdDomain(["which"], h.deps);
    expect(h.calls[0]).toEqual({ method: "domainWhich", params: { path: "/srv/phoenix/sub" } });
    expect(h.stdout).toEqual(["phoenix"]);
  });

  test("expands a relative argument before asking", async () => {
    const h = harness({ domainWhich: { domain: domain(), registered: ["phoenix"] } }, { cwd: "/srv/phoenix" });
    await cmdDomain(["which", "sub/dir"], h.deps);
    expect(h.calls[0].params).toEqual({ path: "/srv/phoenix/sub/dir" });
  });

  test("outside every domain: non-zero exit naming the registered domains", async () => {
    const h = harness({ domainWhich: { domain: null, registered: ["phoenix", "work"] } }, { cwd: "/elsewhere" });
    await expect(cmdDomain(["which"], h.deps)).rejects.toThrow(ExitError);
    const errors = allErrors(h);
    expect(errors).toContain("/elsewhere is not inside any registered domain");
    expect(errors).toContain("phoenix, work");
  });

  test("with nothing registered, says that instead of listing an empty set", async () => {
    const h = harness({ domainWhich: { domain: null, registered: [] } });
    await expect(cmdDomain(["which"], h.deps)).rejects.toThrow(ExitError);
    expect(allErrors(h)).toContain("No domains are registered");
  });
});

describe("mcx domain rename", () => {
  test("sends from/to and reports that the location is unchanged", async () => {
    const h = harness({ domainRename: domain({ name: "phoenix2" }) });
    await cmdDomain(["rename", "phoenix", "phoenix2"], h.deps);
    expect(h.calls[0]).toEqual({ method: "domainRename", params: { from: "phoenix", to: "phoenix2" } });
    expect(allErrors(h)).toContain("/srv/phoenix");
  });

  test("requires both names", async () => {
    const h = harness();
    await expect(cmdDomain(["rename", "only"], h.deps)).rejects.toThrow(ExitError);
    expect(h.calls).toEqual([]);
  });
});

describe("mcx domain rm", () => {
  test("without --force it asks the daemon NOT to cascade", async () => {
    const h = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
    await cmdDomain(["rm", "phoenix"], h.deps);
    expect(h.calls[0]).toEqual({ method: "domainRemove", params: { name: "phoenix", cascade: false } });
  });

  test("a refusal exits non-zero and names the per-table counts", async () => {
    const h = harness({
      domainRemove: {
        found: true,
        removed: false,
        dependents: [
          { table: "work_items", rows: 1000 },
          { table: "mail", rows: 3 },
        ],
      },
    });
    await expect(cmdDomain(["rm", "phoenix"], h.deps)).rejects.toThrow(ExitError);
    const errors = allErrors(h);
    expect(errors).toContain("1003 dependent row(s)");
    expect(errors).toContain("work_items\t1000");
    expect(errors).toContain("mail\t3");
    expect(errors).toContain("--force");
  });

  test("--force cascades and reports how many rows went with it", async () => {
    const h = harness({ domainRemove: { found: true, removed: true, dependents: [{ table: "mail", rows: 3 }] } });
    await cmdDomain(["rm", "phoenix", "--force"], h.deps);
    expect(h.calls[0].params).toEqual({ name: "phoenix", cascade: true });
    // No count: it would be measured outside the delete's transaction (N14).
    const e = allErrors(h);
    expect(e).toContain("along with its dependent rows in: mail");
    expect(e).not.toMatch(/along with \d+ dependent/);
  });

  test("--cascade is accepted as the daemon-side name for --force", async () => {
    const h = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
    await cmdDomain(["rm", "phoenix", "--cascade"], h.deps);
    expect(h.calls[0].params).toEqual({ name: "phoenix", cascade: true });
  });

  test("--force and --cascade are the SAME flag: identical params, asserted as one invariant", async () => {
    // Not two tests that each happen to expect `cascade: true`. `mcx claude bye --all` vs
    // `-a` were documented as aliases and did opposite things — one silently discarded
    // `-d` and ended every session on the box — because nothing compared the two spellings
    // against each other. Two spellings of one destructive flag need an equality assertion,
    // not two independent ones that can drift apart a commit at a time.
    const a = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
    const b = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
    await cmdDomain(["rm", "phoenix", "--force"], a.deps);
    await cmdDomain(["rm", "phoenix", "--cascade"], b.deps);
    expect(a.calls).toEqual(b.calls);
    expect(a.calls[0].params).toEqual({ name: "phoenix", cascade: true });

    // ...and both differ from the unflagged form in exactly one field.
    const c = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
    await cmdDomain(["rm", "phoenix"], c.deps);
    expect(c.calls[0].params).toEqual({ name: "phoenix", cascade: false });
  });

  test("an undeclared flag on the destructive path errors — it is never silently ignored", async () => {
    // The `--scoped` shape: a flag with no parser entry. Here it cannot be a no-op that
    // leaves a destructive default in place, because parseFlags rejects what it was not
    // told about and the command exits before reaching the daemon.
    for (const flag of ["--scoped", "--all", "-a"]) {
      const h = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
      await expect(cmdDomain(["rm", "phoenix", flag], h.deps)).rejects.toThrow(ExitError);
      expect(h.calls).toEqual([]);
    }
  });

  test("unknown domain exits non-zero", async () => {
    const h = harness({ domainRemove: { found: false, removed: false, dependents: [] } });
    await expect(cmdDomain(["rm", "ghost"], h.deps)).rejects.toThrow(ExitError);
    expect(allErrors(h)).toContain('No domain named "ghost"');
  });
});

describe("mcx domain import", () => {
  // `--force` ARMS the next daemon start; it does not import in place. There is
  // deliberately no `ran`/`sealed`/`totalCopied` fixture here — the previous version of
  // this suite pinned `{ran: true, sealed: false, totalCopied: 5}`, a state the merged
  // seal-or-nothing repair makes unreachable, so it was a green test over a path that
  // cannot occur.
  const base = {
    armed: false,
    nonEmpty: [],
    markerKey: "mcx_domain_import_at",
    recovery:
      "to re-run the import from /tmp/s.db: cp /tmp/m.db /tmp/m.db.bak && rm /tmp/m.db && mcx domain import --force, then restart the daemon",
    log: [] as string[],
  };

  test("without --force it names the marker and the recovery, and exits non-zero", async () => {
    const h = harness({
      domainImport: {
        ...base,
        markerSetAt: "2026-08-20T10:00:00.000Z",
        reason: "the legacy database was already imported at 2026-08-20T10:00:00.000Z; re-run with --force",
        log: ["[domain-import] already imported at 2026-08-20T10:00:00.000Z — skipping"],
      },
    });
    await expect(cmdDomain(["import"], h.deps)).rejects.toThrow(ExitError);
    const errors = allErrors(h);
    expect(errors).toContain("mcx_domain_import_at");
    expect(errors).toContain("mcx domain import --force");
    // The daemon's own diagnostics are forwarded, not swallowed.
    expect(errors).toContain("[domain-import] already imported");
  });

  test('arming reports the whole recovery sequence, not just "restart"', async () => {
    // The emptiness guard lives at the boot-time import, not here — a daemon is running
    // whenever this command can be issued and has already written to the database, so an
    // arm-time check would refuse the correct recovery path every time. What the operator
    // needs from THIS command is the full sequence, including the `rm` the import requires.
    const h = harness({ domainImport: { ...base, armed: true } });
    await cmdDomain(["import", "--force"], h.deps);
    const errors = allErrors(h);
    expect(errors).toContain("cp /tmp/m.db /tmp/m.db.bak");
    expect(errors).toContain("rm /tmp/m.db");
    expect(errors).toContain("mcx domain import --force");
  });

  test("--force on an empty target reports armed and tells the operator to restart", async () => {
    const h = harness({ domainImport: { ...base, armed: true } });
    await cmdDomain(["import", "--force"], h.deps);
    expect(h.calls[0]).toEqual({ method: "domainImport", params: { force: true } });
    const errors = allErrors(h);
    expect(errors).toContain("Import re-armed");
    expect(errors).toContain("mcx shutdown");
    // It armed a future import; it did not perform one.
    expect(errors).not.toContain("Imported");
  });
});

describe("mcx domain dispatch", () => {
  test("no subcommand prints help without touching the daemon", async () => {
    const h = harness();
    await cmdDomain([], h.deps);
    expect(h.calls).toEqual([]);
    expect(allErrors(h)).toContain("mcx domain add");
  });

  test("an unknown subcommand exits non-zero", async () => {
    const h = harness();
    await expect(cmdDomain(["frobnicate"], h.deps)).rejects.toThrow(ExitError);
    expect(h.calls).toEqual([]);
  });

  test("an unknown flag is rejected rather than silently ignored", async () => {
    const h = harness({ domainList: [] });
    await expect(cmdDomain(["ls", "--jsonn"], h.deps)).rejects.toThrow(ExitError);
    expect(h.calls).toEqual([]);
  });
});

describe("--help never executes the command (#3160 review finding 8, repo-wide: #1518)", () => {
  // `parseFlags` puts `--help` in `result.help` and leaves the positionals alone, so a
  // subcommand that ignores that field runs normally with the flag simply absent. On `rm`
  // that means a cascading delete. Driven per subcommand rather than asserted once, because
  // the gate is per-call-site and a new subcommand that forgets it is the regression.
  const invocations: Array<[string, string[]]> = [
    ["add", ["add", "phoenix", "/srv/phoenix"]],
    ["ls", ["ls"]],
    ["show", ["show", "phoenix"]],
    ["which", ["which"]],
    ["rename", ["rename", "a", "b"]],
    ["rm", ["rm", "phoenix"]],
    ["import", ["import"]],
  ];

  for (const [name, args] of invocations) {
    for (const flag of ["--help", "-h"]) {
      test(`${name} ${flag} prints help and touches nothing`, async () => {
        const h = harness();
        await cmdDomain([...args, flag], h.deps);
        expect(h.calls).toEqual([]);
        expect(allErrors(h)).toContain("mcx domain add");
      });
    }
  }

  test("rm --force --help does NOT cascade-delete", async () => {
    // The exact shape an operator produces by appending --help to a destructive command
    // they were about to run. Before the gate this reached the daemon with cascade: true.
    const h = harness({ domainRemove: { found: true, removed: true, dependents: [{ table: "mail", rows: 9 }] } });
    await cmdDomain(["rm", "phoenix", "--force", "--help"], h.deps);
    expect(h.calls).toEqual([]);
  });

  test("--help wins over a missing required positional rather than erroring", async () => {
    const h = harness();
    await cmdDomain(["rm", "--help"], h.deps);
    expect(h.calls).toEqual([]);
  });
});

describe("mcx domain rm — concurrent-delete race (#3160 review finding 6)", () => {
  test("removed:false with no dependents is reported as a race, not a 0-row refusal", async () => {
    const h = harness({ domainRemove: { found: true, removed: false, dependents: [] } });
    await expect(cmdDomain(["rm", "phoenix"], h.deps)).rejects.toThrow(ExitError);
    const errors = allErrors(h);
    expect(errors).toContain("removed by something else");
    expect(errors).not.toContain("0 dependent row(s)");
    // Must not advertise --force as the remedy for a domain that is already gone.
    expect(errors).not.toContain("--force");
  });

  test("a real refusal still names the counts and the domain_id caveat", async () => {
    const h = harness({
      domainRemove: { found: true, removed: false, dependents: [{ table: "work_items", rows: 7 }] },
    });
    await expect(cmdDomain(["rm", "phoenix"], h.deps)).rejects.toThrow(ExitError);
    const errors = allErrors(h);
    expect(errors).toContain("7 dependent row(s)");
    expect(errors).toContain("#3155");
  });
});

describe("mcx domain which --json on a miss", () => {
  test("emits parseable JSON and still exits non-zero", async () => {
    const h = harness({ domainWhich: { domain: null, registered: ["phoenix"] } }, { cwd: "/elsewhere" });
    await expect(cmdDomain(["which", "--json"], h.deps)).rejects.toThrow(ExitError);
    expect(JSON.parse(h.stdout.join("\n"))).toEqual({
      path: "/elsewhere",
      domain: null,
      registered: ["phoenix"],
    });
  });
});

describe("mcx domain add — malformed [host:]path (#3160 review finding 3)", () => {
  // Every one of these previously became an absolute-looking path under the caller's cwd
  // (`<cwd>/:/tmp/foo`) and was registered without complaint.
  for (const spec of [":/tmp/foo", "boxen:", ":", "  spacey:/tmp/x"]) {
    test(`rejects ${JSON.stringify(spec)} without calling the daemon`, async () => {
      const h = harness();
      await expect(cmdDomain(["add", "d", spec], h.deps)).rejects.toThrow(ExitError);
      expect(h.calls).toEqual([]);
    });
  }

  test("still accepts the forms that are actually valid", async () => {
    for (const [spec, expected] of [
      ["/tmp/a:b", { host: null, path: "/tmp/a:b" }],
      ["boxen0010:~/work", { host: "boxen0010", path: "~/work" }],
      ["box-1.lan:/srv/x", { host: "box-1.lan", path: "/srv/x" }],
    ] as const) {
      const h = harness({ domainAdd: domain() });
      await cmdDomain(["add", "d", spec], h.deps);
      expect(h.calls[0].params).toEqual({ name: "d", ...expected });
    }
  });
});
