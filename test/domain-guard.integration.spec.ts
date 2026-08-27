/**
 * The domain guard, through the real `mcx` binary (#3036, #3391 review).
 *
 * `packages/command/src/domain-guard.spec.ts` calls `requireDomainScope` directly with a
 * hand-built argv and a mocked `ipcCall`. That is the right shape for pinning the decision,
 * but it cannot see the CLI: the guard's verdict and what the dispatched command then does
 * with the same argv are two different code paths, and every one of the six blockers in
 * #3391's review lived in the gap between them. `-d` on `phase run` passed the guard and
 * then died on `unknown flag: -d`; `mcx track 42 help` passed the guard and wrote a row.
 *
 * So these spawn the process. One daemon, one temp `MCP_CLI_DIR`, two registered domains and
 * one directory that is deliberately outside both — then assert on exit codes, stderr and,
 * where a write is the point, on the rows the daemon actually holds.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestDaemon } from "./harness";
import { rpc, startTestDaemon } from "./harness";

setDefaultTimeout(60_000);

const MCX_SCRIPT = resolve("packages/command/src/main.ts");

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function mcx(dir: string, cwd: string, args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", MCX_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...process.env, MCP_CLI_DIR: dir, NO_COLOR: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const MANIFEST = [
  "version: 1",
  "initial: impl",
  "state:",
  '  scrutiny: { type: "enum[low,medium,high]", track: true }',
  "phases:",
  "  impl: { source: ./impl.ts, next: [qa] }",
  "  qa: { source: ./qa.ts }",
].join("\n");

/** A checkout that looks like a real project: git repo + manifest + phase sources. */
function makeCheckout(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const opts = { stdout: "ignore" as const, stderr: "ignore" as const };
  Bun.spawnSync(["git", "-C", dir, "init", "-q"], opts);
  writeFileSync(join(dir, ".mcx.yaml"), MANIFEST);
  for (const p of ["impl", "qa"]) {
    writeFileSync(join(dir, `${p}.ts`), `export default { name: "${p}", run: async () => ({}) };\n`);
  }
  return dir;
}

describe("domain guard — real CLI, real daemon", () => {
  let daemon: TestDaemon;
  let alpha: string;
  let beta: string;
  let outside: string;

  beforeAll(async () => {
    daemon = await startTestDaemon({});
    alpha = makeCheckout(daemon.dir, "alpha");
    beta = makeCheckout(daemon.dir, "beta");
    // A real checkout, complete with manifest, that is NOT a registered domain. The
    // interesting negative: the files are all there, only the registration is missing.
    outside = makeCheckout(daemon.dir, "unregistered");

    for (const [name, path] of [
      ["alpha", alpha],
      ["beta", beta],
    ] as const) {
      const res = await rpc(daemon.socketPath, "domainAdd", { name, path, host: null });
      expect(res.error).toBeUndefined();
    }
  });

  afterAll(async () => {
    await daemon.kill();
  });

  // ── 🔴 the outside-every-domain refusal actually reaches the process ──────

  test("a domain-scoped command from an unregistered checkout exits 1 and names the domains", async () => {
    const r = await mcx(daemon.dir, outside, ["tracked"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("is not inside any registered domain");
    expect(r.stderr).toContain("Registered domains: alpha, beta");
  });

  // ── 🔴 `-d` on the ambient commands was never dispatchable ────────────────

  test("-d on an ambient command dispatches when it agrees and is refused when it does not", async () => {
    // Spawned together: these are read-only and independent, and one `bun main.ts` cold
    // start each is the whole cost of this file.
    const [show, run, other] = await Promise.all([
      mcx(daemon.dir, alpha, ["phase", "show", "impl", "-d", "alpha"]),
      mcx(daemon.dir, alpha, ["phase", "run", "impl", "-d", "alpha"]),
      mcx(daemon.dir, alpha, ["phase", "show", "impl", "-d", "beta"]),
    ]);

    expect(show.stderr).not.toContain("unknown flag");
    expect(show.exitCode).toBe(0);

    // `phase run` may still fail for want of a work item — what it must NOT do is reject
    // the flag the guard just validated. That was the whole of the first blocker.
    expect(run.stderr).not.toContain("unknown flag");

    expect(other.exitCode).toBe(1);
    expect(other.stderr).toContain("acts on the repository in $PWD");
  });

  // ── 🔴 `-d _` bypassed the refusal entirely for ambient commands ──────────

  test("`-d _` does not bypass the guard for an ambient command", async () => {
    const [phaseControl, phaseUnassigned, aliasControl, aliasUnassigned] = await Promise.all([
      mcx(daemon.dir, outside, ["phase", "show", "impl"]),
      mcx(daemon.dir, outside, ["phase", "show", "impl", "-d", "_"]),
      mcx(daemon.dir, outside, ["alias", "ls"]),
      mcx(daemon.dir, outside, ["alias", "ls", "-d", "_"]),
    ]);

    // Controls: both refuse without the flag, so the flag is the only variable.
    expect(phaseControl.exitCode).toBe(1);
    expect(aliasControl.exitCode).toBe(1);

    for (const r of [phaseUnassigned, aliasUnassigned]) {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is a partition, not a checkout");
    }
  });

  // ── 🔴 `--all` and a stray `help` token disabled the guard for writers ────

  test("neither `--all` nor a stray `help` argument turns the guard off for a writer", async () => {
    const [all, help] = await Promise.all([
      mcx(daemon.dir, outside, ["untrack", "555", "--all"]),
      mcx(daemon.dir, outside, ["track", "42", "help"]),
    ]);

    for (const r of [all, help]) {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not inside any registered domain");
    }

    // Ground truth: the guard's job is that no row exists, not that a message was printed.
    const listed = await rpc(daemon.socketPath, "listWorkItems", { domain: "_" });
    const items = (listed.result as { items: Array<{ issueNumber: number | null }> }).items;
    expect(items.some((i) => i.issueNumber === 42)).toBe(false);
  });

  // ── 🔴 `mcx monitor` must keep its every-domain default ───────────────────

  test("`monitor` runs from outside every domain, but still rejects an unknown -d", async () => {
    // `--timeout 1` gives it a terminator; the point is that the guard did not refuse first.
    const [wide, unknown] = await Promise.all([
      mcx(daemon.dir, outside, ["monitor", "--json", "--timeout", "1"]),
      mcx(daemon.dir, outside, ["monitor", "--json", "--timeout", "1", "-d", "nope"]),
    ]);

    expect(wide.stderr).not.toContain("is not inside any registered domain");
    expect(wide.exitCode).toBe(0);

    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('Unknown domain "nope"');
  });

  // ── 🔴 `-d` on track redirects the row AND its metadata together ──────────

  test("`track -d <other> --scrutiny` puts the item and its state in the same domain", async () => {
    const r = await mcx(daemon.dir, alpha, ["track", "777", "-d", "beta", "--scrutiny", "high"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("Tracking #777");

    // The item is beta's…
    const inBeta = await rpc(daemon.socketPath, "listWorkItems", { domain: "beta" });
    const betaItem = (inBeta.result as { items: Array<{ id: string; issueNumber: number | null }> }).items.find(
      (i) => i.issueNumber === 777,
    );
    expect(betaItem).toBeTruthy();

    // …and so is its `--meta`, read back exactly as a phase script inside beta would:
    // that domain's root, that item's namespace. Before the fix this came back `{}`,
    // because the row had been written under alpha's root in alpha's partition.
    const state = await rpc(daemon.socketPath, "aliasStateAll", {
      repoRoot: beta,
      namespace: `workitem:${betaItem?.id}`,
    });
    expect((state.result as { entries: Record<string, unknown> }).entries).toEqual({ scrutiny: "high" });

    // And nothing about it landed in the caller's own domain.
    const inAlpha = await rpc(daemon.socketPath, "listWorkItems", { domain: "alpha" });
    const alphaItems = (inAlpha.result as { items: Array<{ issueNumber: number | null }> }).items;
    expect(alphaItems.some((i) => i.issueNumber === 777)).toBe(false);
    const alphaState = await rpc(daemon.socketPath, "aliasStateAll", {
      repoRoot: alpha,
      namespace: `workitem:${betaItem?.id}`,
    });
    expect((alphaState.result as { entries: Record<string, unknown> }).entries).toEqual({});
  });

  test("`untrack -d <other>` removes the item and its state from that domain", async () => {
    await mcx(daemon.dir, alpha, ["track", "778", "-d", "beta", "--scrutiny", "low"]);
    const before = await rpc(daemon.socketPath, "listWorkItems", { domain: "beta" });
    const item = (before.result as { items: Array<{ id: string; issueNumber: number | null }> }).items.find(
      (i) => i.issueNumber === 778,
    );
    expect(item).toBeTruthy();

    const r = await mcx(daemon.dir, alpha, ["untrack", "778", "-d", "beta"]);
    expect(r.exitCode).toBe(0);

    const after = await rpc(daemon.socketPath, "listWorkItems", { domain: "beta" });
    expect(
      (after.result as { items: Array<{ issueNumber: number | null }> }).items.some((i) => i.issueNumber === 778),
    ).toBe(false);
    const state = await rpc(daemon.socketPath, "aliasStateAll", {
      repoRoot: beta,
      namespace: `workitem:${item?.id}`,
    });
    expect((state.result as { entries: Record<string, unknown> }).entries).toEqual({});
  });

  test("`tracked -d <other> --json` reports that domain's items and their state", async () => {
    await mcx(daemon.dir, alpha, ["track", "779", "-d", "beta", "--scrutiny", "medium"]);
    const r = await mcx(daemon.dir, alpha, ["tracked", "-d", "beta", "--json"]);
    expect(r.exitCode).toBe(0);
    const items = JSON.parse(r.stdout) as Array<{ issueNumber: number | null; state?: Record<string, unknown> }>;
    const found = items.find((i) => i.issueNumber === 779);
    expect(found?.state).toEqual({ scrutiny: "medium" });
  });

  // ── 🟡 `list` is `ls` under another name ─────────────────────────────────

  test("`claude list` is guarded exactly like `claude ls`, and `--all` still escapes both", async () => {
    const [ls, list, all] = await Promise.all([
      mcx(daemon.dir, outside, ["claude", "ls"]),
      mcx(daemon.dir, outside, ["claude", "list"]),
      mcx(daemon.dir, outside, ["claude", "ls", "--all"]),
    ]);
    expect(ls.exitCode).toBe(1);
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain("is not inside any registered domain");
    expect(all.exitCode).toBe(0);
  });

  // ── the positive control: everything works from inside a domain ───────────

  test("every guarded surface succeeds from inside a registered domain", async () => {
    const surfaces = [["tracked"], ["claude", "ls"], ["phase", "show", "impl"], ["alias", "ls"], ["monitor", "--help"]];
    const results = await Promise.all(surfaces.map((args) => mcx(daemon.dir, alpha, args)));
    for (const [i, r] of results.entries()) {
      expect(`${surfaces[i].join(" ")}: ${r.stderr}`).not.toContain("is not inside any registered domain");
      expect(`${surfaces[i].join(" ")} → ${r.exitCode}`).toBe(`${surfaces[i].join(" ")} → 0`);
    }
  });
});
