import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DisallowedTransitionError,
  RegressionError,
  UnknownPhaseError,
  historyTargets,
  parseLockfile,
  readTransitionHistory,
} from "@mcp-cli/core";
import {
  checkStateSubset,
  cmdPhase,
  parsePhaseRunArgs,
  phaseRun,
  resolvePhaseSource,
  transitionLogPath,
} from "./phase";

const manifestYaml = `
initial: impl
phases:
  impl:
    source: ./impl.ts
    next: [adversarial-review, qa, needs-attention]
  adversarial-review:
    source: ./review.ts
    next: [repair, qa]
  repair:
    source: ./repair.ts
    next: [adversarial-review, qa]
  qa:
    source: ./qa.ts
    next: [done, needs-attention]
  needs-attention:
    source: ./na.ts
    next: [impl, done]
  done:
    source: ./done.ts
    next: []
`.trim();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcx-phase-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolvePhaseSource", () => {
  test("resolves relative paths against repo root", () => {
    expect(resolvePhaseSource("./foo.ts", "/repo")).toBe("/repo/foo.ts");
  });

  test("resolves bare relative paths against repo root", () => {
    expect(resolvePhaseSource("scripts/foo.ts", "/repo")).toBe("/repo/scripts/foo.ts");
  });

  test("passes absolute paths through", () => {
    expect(resolvePhaseSource("/abs/path.ts", "/repo")).toBe("/abs/path.ts");
  });

  test("handles file:// URIs", () => {
    expect(resolvePhaseSource("file:///abs/path.ts", "/repo")).toBe("/abs/path.ts");
  });

  test("rejects remote `scheme://` URIs", () => {
    expect(() => resolvePhaseSource("https://example.com/x.ts", "/repo")).toThrow(/remote sources/);
    expect(() => resolvePhaseSource("github://owner/repo/path.ts", "/repo")).toThrow(/remote sources/);
  });
});

describe("checkStateSubset", () => {
  test("empty phase state is always a subset", () => {
    expect(checkStateSubset("p", undefined, { foo: "string" })).toEqual([]);
    expect(checkStateSubset("p", {}, { foo: "string" })).toEqual([]);
  });

  test("phase key not in manifest state is an error", () => {
    const errs = checkStateSubset("p", { extra: {} }, { foo: "string" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('phase "p"');
    expect(errs[0]).toContain('"extra"');
  });

  test("phase is subset of manifest state", () => {
    expect(checkStateSubset("p", { foo: {} }, { foo: "string", bar: "number" })).toEqual([]);
  });
});

const simpleAlias = `
import { defineAlias, z } from "mcp-cli";

defineAlias(({ z }) => ({
  name: "implement",
  description: "Implement phase",
  input: z.object({ issue: z.number() }),
  output: z.object({ pr: z.number() }),
  fn: async (input) => ({ pr: input.issue + 1 }),
}));
`.trim();

const simpleManifest = `
initial: implement
phases:
  implement:
    source: ./impl.ts
    next: []
`.trim();

describe("cmdPhase install — integration", () => {
  test("writes .mcx.lock after resolving sources", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);

    const logs: string[] = [];
    const errs: string[] = [];
    await cmdPhase(["install"], {
      cwd: () => dir,
      log: (m) => logs.push(m),
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        throw new Error(`exit(${code})`);
      }) as (code: number) => never,
    });

    const lockPath = join(dir, ".mcx.lock");
    expect(existsSync(lockPath)).toBe(true);

    const lock = parseLockfile(readFileSync(lockPath, "utf-8"));
    expect(lock.version).toBe(1);
    expect(lock.phases).toHaveLength(1);
    expect(lock.phases[0].name).toBe("implement");
    expect(lock.phases[0].resolvedPath).toBe("impl.ts");
    expect(lock.phases[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.phases[0].schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs.some((l) => l.includes("Installed 1 phase"))).toBe(true);
  }, 15_000);

  test("errors when no manifest present", async () => {
    const errs: string[] = [];
    let exitCode: number | undefined;
    await cmdPhase(["install"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        exitCode = code;
        throw new Error("exit");
      }) as (code: number) => never,
    }).catch(() => {});

    expect(exitCode).toBe(1);
    expect(errs.some((e) => e.includes("no .mcx.yaml or .mcx.json"))).toBe(true);
  });

  test("errors when source not found", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);

    const errs: string[] = [];
    let exitCode: number | undefined;
    await cmdPhase(["install"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        exitCode = code;
        throw new Error("exit");
      }) as (code: number) => never,
    }).catch(() => {});

    expect(exitCode).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain('phase "implement"');
    expect(joined).toContain("not found");
  });
});

describe("parsePhaseRunArgs", () => {
  test("positional target only", () => {
    expect(parsePhaseRunArgs(["qa"])).toEqual({ target: "qa", from: null, workItemId: null, forceMessage: null });
  });

  test("--from, --work-item", () => {
    const o = parsePhaseRunArgs(["qa", "--from", "impl", "--work-item", "#123"]);
    expect(o.from).toBe("impl");
    expect(o.workItemId).toBe("#123");
  });

  test("--from=impl, --work-item=#123 (equals form)", () => {
    const o = parsePhaseRunArgs(["qa", "--from=impl", "--work-item=#123"]);
    expect(o.from).toBe("impl");
    expect(o.workItemId).toBe("#123");
  });

  test("--force <message>", () => {
    const o = parsePhaseRunArgs(["impl", "--from", "adversarial-review", "--force", "rewriting from scratch"]);
    expect(o.forceMessage).toBe("rewriting from scratch");
  });

  test("--force alone is an error", () => {
    expect(() => parsePhaseRunArgs(["impl", "--force"])).toThrow(/--force requires/);
  });

  test("--force followed by another flag is also an error", () => {
    expect(() => parsePhaseRunArgs(["impl", "--force", "--from", "qa"])).toThrow(/--force requires/);
  });

  test("missing target is an error", () => {
    expect(() => parsePhaseRunArgs([])).toThrow(/Usage:/);
  });
});

describe("phaseRun", () => {
  beforeEach(() => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestYaml);
  });

  test("valid transition is logged", () => {
    const result = phaseRun({ target: "qa", from: "impl", workItemId: "#42", forceMessage: null }, { cwd: dir });
    expect(result.forced).toBe(false);
    expect(result.from).toBe("impl");
    const entries = readTransitionHistory(transitionLogPath(dir), "#42");
    expect(historyTargets(entries)).toEqual(["qa"]);
  });

  test("infers --from from the most recent log entry for the work item", () => {
    phaseRun({ target: "qa", from: "impl", workItemId: "#7", forceMessage: null }, { cwd: dir });
    const result = phaseRun({ target: "done", from: null, workItemId: "#7", forceMessage: null }, { cwd: dir });
    expect(result.from).toBe("qa");
  });

  test("unknown target throws UnknownPhaseError with suggestions", () => {
    try {
      phaseRun({ target: "qaa", from: "impl", workItemId: null, forceMessage: null }, { cwd: dir });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPhaseError);
      expect((err as UnknownPhaseError).suggestions).toContain("qa");
    }
  });

  test("disallowed transition throws DisallowedTransitionError", () => {
    expect(() =>
      phaseRun({ target: "repair", from: "impl", workItemId: null, forceMessage: null }, { cwd: dir }),
    ).toThrow(DisallowedTransitionError);
  });

  test("regression throws RegressionError for undeclared revisit", () => {
    // impl → adversarial-review → repair → qa, then try qa → impl.
    // impl is in history but NOT in qa.next → RegressionError.
    // (needs-attention → impl is a declared back-edge and would be allowed.)
    phaseRun({ target: "impl", from: null, workItemId: "#9", forceMessage: null }, { cwd: dir });
    phaseRun({ target: "adversarial-review", from: "impl", workItemId: "#9", forceMessage: null }, { cwd: dir });
    phaseRun({ target: "repair", from: "adversarial-review", workItemId: "#9", forceMessage: null }, { cwd: dir });
    phaseRun({ target: "qa", from: "repair", workItemId: "#9", forceMessage: null }, { cwd: dir });
    expect(() => phaseRun({ target: "impl", from: "qa", workItemId: "#9", forceMessage: null }, { cwd: dir })).toThrow(
      RegressionError,
    );
  });

  test("--force bypasses disallowed transition and records the message", () => {
    const result = phaseRun(
      { target: "repair", from: "impl", workItemId: "#11", forceMessage: "emergency rework" },
      { cwd: dir },
    );
    expect(result.forced).toBe(true);
    const entries = readTransitionHistory(transitionLogPath(dir), "#11");
    expect(entries[0].forceMessage).toBe("emergency rework");
  });

  test("--force does NOT bypass unknown phase", () => {
    expect(() =>
      phaseRun({ target: "qaa", from: "impl", workItemId: null, forceMessage: "trust me" }, { cwd: dir }),
    ).toThrow(UnknownPhaseError);
  });

  test("missing manifest throws a clear error", () => {
    const empty = mkdtempSync(join(tmpdir(), "mcx-phase-empty-"));
    try {
      expect(() =>
        phaseRun({ target: "qa", from: null, workItemId: null, forceMessage: null }, { cwd: empty }),
      ).toThrow(/no \.mcx\.yaml or \.mcx\.json/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("cmdPhase dispatch", () => {
  beforeEach(() => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestYaml);
  });

  async function catchExit(
    fn: () => Promise<unknown>,
  ): Promise<{ code: number | undefined; out: string; err: string }> {
    const origExit = process.exit;
    const origLog = console.log;
    const origErr = console.error;
    let exitCode: number | undefined;
    let out = "";
    let err = "";
    process.exit = ((c?: number) => {
      exitCode = c;
      throw new Error("__exit__");
    }) as typeof process.exit;
    console.log = (...a: unknown[]) => {
      out += `${a.join(" ")}\n`;
    };
    console.error = (...a: unknown[]) => {
      err += `${a.join(" ")}\n`;
    };
    try {
      await fn().catch((e) => {
        if ((e as Error).message !== "__exit__") throw e;
      });
    } finally {
      process.exit = origExit;
      console.log = origLog;
      console.error = origErr;
    }
    return { code: exitCode, out, err };
  }

  async function withCwd<T>(newCwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.cwd();
    process.chdir(newCwd);
    try {
      return await fn();
    } finally {
      process.chdir(prev);
    }
  }

  test("no args prints usage", async () => {
    const { out, code } = await catchExit(() => cmdPhase([]));
    expect(code).toBeUndefined();
    expect(out).toContain("mcx phase");
  });

  test("--help prints usage", async () => {
    const { out } = await catchExit(() => cmdPhase(["--help"]));
    expect(out).toContain("Subcommands");
  });

  test("list prints phases alphabetically", async () => {
    const { out } = await withCwd(dir, () => catchExit(() => cmdPhase(["list"])));
    const lines = out.trim().split("\n");
    expect(lines).toEqual([...lines].sort());
    expect(lines).toContain("qa");
  });

  test("list exits 1 when no manifest", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mcx-phase-cmd-empty-"));
    try {
      const { code, err } = await withCwd(empty, () => catchExit(() => cmdPhase(["list"])));
      expect(code).toBe(1);
      expect(err).toContain("no .mcx.yaml");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("run prints approval on valid transition", async () => {
    const { err, code } = await withCwd(dir, () => catchExit(() => cmdPhase(["run", "qa", "--from", "impl"])));
    expect(code).toBeUndefined();
    expect(err).toContain("approved");
    expect(err).toContain("impl → qa");
  });

  test("run with --force tags output", async () => {
    const { err } = await withCwd(dir, () =>
      catchExit(() => cmdPhase(["run", "repair", "--from", "impl", "--force", "emergency"])),
    );
    expect(err).toContain("[FORCED]");
  });

  test("run on unknown phase exits 1 with suggestions", async () => {
    const { code, err } = await withCwd(dir, () => catchExit(() => cmdPhase(["run", "qaa", "--from", "impl"])));
    expect(code).toBe(1);
    expect(err).toContain("unknown phase");
    expect(err).toContain("qa");
  });

  test("run on disallowed transition exits 1", async () => {
    const { code, err } = await withCwd(dir, () => catchExit(() => cmdPhase(["run", "repair", "--from", "impl"])));
    expect(code).toBe(1);
    expect(err).toContain("not an approved transition");
  });

  test("run with bad flag exits 1", async () => {
    const { code, err } = await withCwd(dir, () => catchExit(() => cmdPhase(["run", "qa", "--bogus"])));
    expect(code).toBe(1);
    expect(err).toContain("unknown flag");
  });

  test("run with no manifest exits 1", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mcx-phase-cmd-empty2-"));
    try {
      const { code, err } = await withCwd(empty, () => catchExit(() => cmdPhase(["run", "qa"])));
      expect(code).toBe(1);
      expect(err).toContain("no .mcx.yaml");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("unknown subcommand exits 1", async () => {
    const { code, err } = await catchExit(() => cmdPhase(["bogus"]));
    expect(code).toBe(1);
    expect(err).toContain("Unknown subcommand");
  });
});
