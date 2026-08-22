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
    expect(allErrors(h)).toContain("3 dependent row(s)");
  });

  test("--cascade is accepted as the daemon-side name for --force", async () => {
    const h = harness({ domainRemove: { found: true, removed: true, dependents: [] } });
    await cmdDomain(["rm", "phoenix", "--cascade"], h.deps);
    expect(h.calls[0].params).toEqual({ name: "phoenix", cascade: true });
  });

  test("unknown domain exits non-zero", async () => {
    const h = harness({ domainRemove: { found: false, removed: false, dependents: [] } });
    await expect(cmdDomain(["rm", "ghost"], h.deps)).rejects.toThrow(ExitError);
    expect(allErrors(h)).toContain('No domain named "ghost"');
  });
});

describe("mcx domain import", () => {
  const declined = {
    ran: false,
    sealed: false,
    reason: "already imported at 2026-08-20T10:00:00.000Z",
    tables: [],
    failedTables: [],
    domainsImported: 0,
    domainsSkipped: 0,
    totalCopied: 0,
    totalNotCopied: 0,
    markerKey: "mcx_domain_import_at",
    log: ["[domain-import] already imported at 2026-08-20T10:00:00.000Z — skipping"],
  };

  test("a decline without --force names the marker and points at --force", async () => {
    const h = harness({ domainImport: declined });
    await expect(cmdDomain(["import"], h.deps)).rejects.toThrow(ExitError);
    const errors = allErrors(h);
    expect(errors).toContain("mcx_domain_import_at");
    expect(errors).toContain("mcx domain import --force");
    // The importer's own diagnostics are forwarded, not swallowed.
    expect(errors).toContain("[domain-import] already imported");
  });

  test("--force is sent through to the daemon", async () => {
    const h = harness({
      domainImport: {
        ...declined,
        ran: true,
        sealed: true,
        reason: undefined,
        totalCopied: 42,
        domainsImported: 2,
        log: [],
      },
    });
    await cmdDomain(["import", "--force"], h.deps);
    expect(h.calls[0]).toEqual({ method: "domainImport", params: { force: true } });
    expect(allErrors(h)).toContain("Imported 42 row(s) and 2 domain(s)");
  });

  test("a partial import (marker withheld) exits non-zero and says it will retry", async () => {
    const h = harness({
      domainImport: {
        ...declined,
        ran: true,
        sealed: false,
        reason: undefined,
        totalCopied: 5,
        failedTables: ["mail"],
        log: [],
      },
    });
    await expect(cmdDomain(["import", "--force"], h.deps)).rejects.toThrow(ExitError);
    expect(allErrors(h)).toContain("retries on the next daemon start");
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
