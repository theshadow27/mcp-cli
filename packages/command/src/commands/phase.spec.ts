import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DisallowedTransitionError,
  RegressionError,
  UnknownPhaseError,
  appendTransitionLog,
  historyTargets,
  parseLockfile,
  readTransitionHistory,
} from "@mcp-cli/core";
import {
  bundleAlias,
  extractMetadata,
  hashFileSync,
  loadManifest,
  parseManifestText,
  validateManifest,
} from "@mcp-cli/core";
import {
  type PhaseInstallDeps,
  buildPhaseList,
  buildPhaseShow,
  checkStateSubset,
  cmdPhase,
  detectDrift,
  executePhase,
  explainTransition,
  filterTransitionLog,
  formatDriftWarning,
  formatPhaseTable,
  formatTransitionLog,
  parsePhaseExecuteArgs,
  parsePhaseLogArgs,
  parsePhaseRunArgs,
  phaseRun,
  resolvePhaseSource,
  shortestPhasePath,
  spawnExec,
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

  test("run --dry-run logs mcp + state writes without dispatching", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(
      join(dir, "impl.ts"),
      `
import { defineAlias, z } from "mcp-cli";

defineAlias(({ z }) => ({
  name: "implement",
  description: "impl",
  input: z.object({}).optional(),
  fn: async (_input, ctx) => {
    await ctx.mcp._work_items.work_items_update({ id: "#1241", phase: "qa" });
    await ctx.mcp._work_items.untrack({ issue: 1241 });
    await ctx.state.set("prNumber", 123);
  },
}));
`.trim(),
    );

    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    const logs: string[] = [];
    const errs: string[] = [];
    await cmdPhase(["run", "implement", "--dry-run"], {
      cwd: () => dir,
      log: (m) => logs.push(m),
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        throw new Error(`exit(${code})`);
      }) as (code: number) => never,
    });

    expect(logs).toEqual([
      `[dry-run] mcp._work_items.work_items_update({"id":"#1241","phase":"qa"})`,
      `[dry-run] mcp._work_items.untrack({"issue":1241})`,
      `[dry-run] ctx.state.set("prNumber", 123)`,
    ]);
  }, 15_000);

  test("run --dry-run --arg forwards key=val into ctx.args", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(
      join(dir, "impl.ts"),
      `
import { defineAlias, z } from "mcp-cli";

defineAlias(({ z }) => ({
  name: "implement",
  description: "impl",
  input: z.object({}).optional(),
  fn: async (_input, ctx) => {
    await ctx.state.set("issue", ctx.args.issue);
    await ctx.state.set("branch", ctx.args.branch);
  },
}));
`.trim(),
    );

    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    const logs: string[] = [];
    const errs: string[] = [];
    await cmdPhase(["run", "implement", "--dry-run", "--arg", "issue=1296", "--arg", "branch=feat/x"], {
      cwd: () => dir,
      log: (m) => logs.push(m),
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        throw new Error(`exit(${code})`);
      }) as (code: number) => never,
    });

    expect(logs).toEqual([`[dry-run] ctx.state.set("issue", "1296")`, `[dry-run] ctx.state.set("branch", "feat/x")`]);
    expect(errs).toEqual([]);
  }, 15_000);

  test("run --dry-run --arg errors on missing value", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const errs: string[] = [];
    let code: number | undefined;
    await cmdPhase(["run", "implement", "--dry-run", "--arg"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    }).catch(() => {});
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes("--arg requires"))).toBe(true);
  });

  test("run --dry-run --arg errors on missing = separator", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const errs: string[] = [];
    let code: number | undefined;
    await cmdPhase(["run", "implement", "--dry-run", "--arg", "noequals"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    }).catch(() => {});
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes("key=val"))).toBe(true);
  });

  test("run errors on unknown phase", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const errs: string[] = [];
    let code: number | undefined;
    await cmdPhase(["run", "nope", "--dry-run"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    }).catch(() => {});
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('unknown phase "nope"'))).toBe(true);
  });

  test("run --dry-run formats handler errors with phase name (#1349)", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(
      join(dir, "impl.ts"),
      `
import { defineAlias, z } from "mcp-cli";

defineAlias(({ z }) => ({
  name: "implement",
  description: "impl",
  input: z.object({}).optional(),
  fn: async () => {
    throw new Error("boom from handler");
  },
}));
`.trim(),
    );
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const errs: string[] = [];
    let code: number | undefined;
    await cmdPhase(["run", "implement", "--dry-run"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    }).catch(() => {});
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('phase "implement" threw') && e.includes("boom from handler"))).toBe(true);
  }, 15_000);

  test("run --no-execute dispatches to transition enforcement only", async () => {
    // #1381 wired real handler execution on `run <target>` without --dry-run.
    // `--no-execute` is the escape hatch for orchestrators that want to log
    // the transition separately from dispatch.
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const errs: string[] = [];
    let code: number | undefined;
    await cmdPhase(["run", "implement", "--no-execute"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    }).catch(() => {});
    // simpleManifest has initial: implement — transition is valid from initial state
    expect(code).toBeUndefined();
    expect(errs.some((e) => e.includes("approved") && e.includes("implement"))).toBe(true);
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
  beforeEach(async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestYaml);
    const srcs: [string, string][] = [
      ["impl.ts", "impl"],
      ["review.ts", "adversarial-review"],
      ["repair.ts", "repair"],
      ["qa.ts", "qa"],
      ["na.ts", "needs-attention"],
      ["done.ts", "done"],
    ];
    for (const [file, name] of srcs) {
      writeFileSync(
        join(dir, file),
        `import { defineAlias, z } from "mcp-cli";\ndefineAlias(({ z }) => ({ name: ${JSON.stringify(name)}, description: "d", input: z.object({}).optional(), fn: async () => {} }));\n`,
      );
    }
    const { deps } = makeDriftDeps(dir);
    await cmdPhase(["install"], deps);
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
    const { out } = await catchExit(() => cmdPhase(["list"], { cwd: () => dir }));
    const lines = out.trim().split("\n");
    // skip header; remaining rows should be alphabetical by name
    const names = lines.slice(1).map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("qa");
  });

  test("list exits 1 when no manifest", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mcx-phase-cmd-empty-"));
    try {
      const { code, err } = await catchExit(() => cmdPhase(["list"], { cwd: () => empty }));
      expect(code).toBe(1);
      expect(err).toContain("no .mcx.yaml");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("run --no-execute prints approval on valid transition", async () => {
    const { err, code } = await catchExit(() =>
      cmdPhase(["run", "qa", "--from", "impl", "--no-execute"], { cwd: () => dir }),
    );
    expect(code).toBeUndefined();
    expect(err).toContain("approved");
    expect(err).toContain("impl → qa");
  });

  test("run --no-execute with --force tags output", async () => {
    const { err } = await catchExit(() =>
      cmdPhase(["run", "repair", "--from", "impl", "--force", "emergency", "--no-execute"], { cwd: () => dir }),
    );
    expect(err).toContain("[FORCED]");
  });

  test("run on unknown phase exits 1 with suggestions", async () => {
    const { code, err } = await catchExit(() => cmdPhase(["run", "qaa", "--from", "impl"], { cwd: () => dir }));
    expect(code).toBe(1);
    expect(err).toContain("unknown phase");
    expect(err).toContain("qa");
  });

  test("run on disallowed transition exits 1", async () => {
    const { code, err } = await catchExit(() => cmdPhase(["run", "repair", "--from", "impl"], { cwd: () => dir }));
    expect(code).toBe(1);
    expect(err).toContain("not an approved transition");
  });

  test("run with bad flag exits 1", async () => {
    const { code, err } = await catchExit(() => cmdPhase(["run", "qa", "--bogus"], { cwd: () => dir }));
    expect(code).toBe(1);
    expect(err).toContain("unknown flag");
  });

  test("run with no manifest exits 1", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mcx-phase-cmd-empty2-"));
    try {
      const { code, err } = await catchExit(() => cmdPhase(["run", "qa"], { cwd: () => empty }));
      expect(code).toBe(1);
      // drift-check fires first; no-lockfile precedes no-manifest when both are absent
      expect(err).toContain("no .mcx.lock");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("run aborts with drift warning when phase source is tampered", async () => {
    // Mutate a phase source after install — drift check must block dispatch
    writeFileSync(join(dir, "qa.ts"), `${readFileSync(join(dir, "qa.ts"), "utf-8")}\n// tampered\n`);
    const { code, err } = await catchExit(() => cmdPhase(["run", "qa", "--from", "impl"], { cwd: () => dir }));
    expect(code).toBe(1);
    expect(err).toContain("PHASE LOCKFILE DRIFT DETECTED");
    expect(err).toContain("qa.ts");
  });

  test("run --dry-run aborts on drift before dispatch", async () => {
    writeFileSync(join(dir, "qa.ts"), `${readFileSync(join(dir, "qa.ts"), "utf-8")}\n// tampered\n`);
    const { code, err } = await catchExit(() => cmdPhase(["run", "qa", "--dry-run"], { cwd: () => dir }));
    expect(code).toBe(1);
    expect(err).toContain("PHASE LOCKFILE DRIFT DETECTED");
  });

  test("unknown subcommand exits 1", async () => {
    const { code, err } = await catchExit(() => cmdPhase(["bogus"]));
    expect(code).toBe(1);
    expect(err).toContain("Unknown subcommand");
  });
});

function loadTestManifest(yaml: string): ReturnType<typeof validateManifest> {
  return validateManifest(parseManifestText(yaml, "test.yaml"), "test.yaml");
}

describe("shortestPhasePath", () => {
  const m = loadTestManifest(manifestYaml);

  test("direct edge returns two-node path", () => {
    expect(shortestPhasePath(m, "impl", "qa")).toEqual(["impl", "qa"]);
  });

  test("multi-hop returns shortest path", () => {
    expect(shortestPhasePath(m, "impl", "done")).toEqual(["impl", "qa", "done"]);
  });

  test("unreachable returns null", () => {
    expect(shortestPhasePath(m, "done", "impl")).toBeNull();
  });

  test("unknown phase returns null", () => {
    expect(shortestPhasePath(m, "bogus", "qa")).toBeNull();
    expect(shortestPhasePath(m, "impl", "bogus")).toBeNull();
  });
});

describe("explainTransition", () => {
  const m = loadTestManifest(manifestYaml);

  test("direct transition is legal", () => {
    const r = explainTransition(m, "impl", "qa");
    expect(r.legal).toBe(true);
    expect(r.kind).toBe("direct");
    expect(r.message).toContain("approved direct transition");
  });

  test("indirect transition shows shortest path", () => {
    const r = explainTransition(m, "impl", "done");
    expect(r.legal).toBe(true);
    expect(r.kind).toBe("indirect");
    expect(r.path).toEqual(["impl", "qa", "done"]);
    expect(r.message).toContain("shortest legal path");
  });

  test("regression: reverse path exists", () => {
    const r = explainTransition(m, "done", "impl");
    // done is terminal (no next), but impl can reach done; this is a regression.
    expect(r.legal).toBe(false);
    expect(r.kind).toBe("regression");
    expect(r.message).toContain("regress");
  });

  test("unknown phase reports suggestions", () => {
    const r = explainTransition(m, "impll", "qa");
    expect(r.legal).toBe(false);
    expect(r.kind).toBe("unknown-phase");
    expect(r.message).toContain("impl");
  });

  test("same phase is disallowed, not indirect", () => {
    const r = explainTransition(m, "impl", "impl");
    expect(r.legal).toBe(false);
    expect(r.kind).toBe("disallowed");
    expect(r.message).toContain("already");
  });

  test("cycle: from-phase is in a cycle but cannot reach to-phase", () => {
    // Manifest: entry → left → right → left (left/right form a cycle).
    // Asking left → entry: left is in a cycle, has no forward path to entry,
    // but entry can reach left — should return kind:"cycle", not "regression".
    const cycleManifest = loadTestManifest(
      `
initial: entry
phases:
  entry:
    source: ./entry.ts
    next: [left]
  left:
    source: ./left.ts
    next: [right]
  right:
    source: ./right.ts
    next: [left]
`.trim(),
    );
    const r = explainTransition(cycleManifest, "left", "entry");
    expect(r.legal).toBe(false);
    expect(r.kind).toBe("cycle");
    expect(r.message).toContain("cycle");
    expect(r.message).toContain("entry");
    expect(r.path).toBeDefined();
  });

  test("regression stays regression when from-phase is NOT in a cycle", () => {
    // done is terminal (not in a cycle), so done → impl is a plain regression
    const r = explainTransition(m, "done", "impl");
    expect(r.legal).toBe(false);
    expect(r.kind).toBe("regression");
    expect(r.message).toContain("regress");
  });
});

describe("buildPhaseList / formatPhaseTable", () => {
  test("status is 'missing' without lockfile", () => {
    const m = loadTestManifest(manifestYaml);
    const rows = buildPhaseList(m, null, "/nonexistent");
    expect(rows.every((r) => r.status === "missing")).toBe(true);
    expect(rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name)].sort());
  });

  test("formatPhaseTable renders header and rows", () => {
    const rows = [
      { name: "impl", source: "./impl.ts", status: "ok" as const, next: ["qa"] },
      { name: "done", source: "./done.ts", status: "drift" as const, next: [] },
    ];
    const lines = formatPhaseTable(rows);
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("NEXT");
    expect(lines.some((l) => l.includes("impl") && l.includes("ok"))).toBe(true);
    expect(lines.some((l) => l.includes("—"))).toBe(true);
  });
});

describe("buildPhaseShow", () => {
  test("returns preview and resolved path", () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const m = loadTestManifest(simpleManifest);
    const info = buildPhaseShow("implement", m.phases.implement, m, null, dir, false);
    expect(info.resolvedPath).toBe("impl.ts");
    expect(info.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(info.preview.length).toBeGreaterThan(0);
    expect(info.lastInstalled).toBeNull();
  });

  test("truncates preview unless --full", () => {
    const longSrc = Array.from({ length: 30 }, (_, i) => `// line ${i}`).join("\n");
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), longSrc);
    const m = loadTestManifest(simpleManifest);
    const short = buildPhaseShow("implement", m.phases.implement, m, null, dir, false);
    expect(short.preview).toHaveLength(20);
    expect(short.previewTruncated).toBe(true);
    const full = buildPhaseShow("implement", m.phases.implement, m, null, dir, true);
    expect(full.preview.length).toBeGreaterThan(20);
    expect(full.previewTruncated).toBe(false);
  });
});

describe("cmdPhase show / why / list-json — integration", () => {
  beforeEach(() => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestYaml);
    for (const f of ["impl.ts", "review.ts", "repair.ts", "qa.ts", "na.ts", "done.ts"]) {
      writeFileSync(join(dir, f), "// stub\n");
    }
  });

  async function runCapture(
    args: string[],
    deps?: Partial<PhaseInstallDeps>,
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
      await cmdPhase(args, deps).catch((e) => {
        if ((e as Error).message !== "__exit__") throw e;
      });
    } finally {
      process.exit = origExit;
      console.log = origLog;
      console.error = origErr;
    }
    return { code: exitCode, out, err };
  }

  test("list renders table with NAME/SOURCE/STATUS/NEXT", async () => {
    const { out } = await runCapture(["list"], { cwd: () => dir });
    expect(out).toContain("NAME");
    expect(out).toContain("SOURCE");
    expect(out).toContain("STATUS");
    expect(out).toContain("NEXT");
    expect(out).toContain("impl");
    expect(out).toContain("missing");
  });

  test("list --json emits structured output", async () => {
    const { out } = await runCapture(["list", "--json"], { cwd: () => dir });
    const rows = JSON.parse(out);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty("name");
    expect(rows[0]).toHaveProperty("status");
    expect(rows[0]).toHaveProperty("next");
  });

  test("show prints phase details", async () => {
    const { out, code } = await runCapture(["show", "impl"], { cwd: () => dir });
    expect(code).toBeUndefined();
    expect(out).toContain("phase: impl");
    expect(out).toContain("source: ./impl.ts");
    expect(out).toContain("next:");
    expect(out).toContain("adversarial-review");
  });

  test("show on unknown phase exits 1 with suggestions", async () => {
    const { code, err } = await runCapture(["show", "impll"], { cwd: () => dir });
    expect(code).toBe(1);
    expect(err).toContain("unknown phase");
    expect(err).toContain("impl");
  });

  test("show --json returns JSON", async () => {
    const { out } = await runCapture(["show", "impl", "--json"], { cwd: () => dir });
    const info = JSON.parse(out);
    expect(info.name).toBe("impl");
    expect(info.next).toContain("qa");
  });

  test("show without name exits 1", async () => {
    const { code, err } = await runCapture(["show"], { cwd: () => dir });
    expect(code).toBe(1);
    expect(err).toContain("Usage:");
  });

  test("why reports direct transitions", async () => {
    const { out, code } = await runCapture(["why", "impl", "qa"], { cwd: () => dir });
    expect(code).toBeUndefined();
    expect(out).toContain("approved direct transition");
  });

  test("why reports indirect transitions", async () => {
    const { out, code } = await runCapture(["why", "impl", "done"], { cwd: () => dir });
    expect(code).toBeUndefined();
    expect(out).toContain("shortest legal path");
    expect(out).toContain("qa");
  });

  test("why reports regression with exit 1", async () => {
    const { out, code } = await runCapture(["why", "done", "impl"], { cwd: () => dir });
    expect(code).toBe(1);
    expect(out).toContain("regress");
  });

  test("why reports unknown phase with exit 1", async () => {
    const { out, code } = await runCapture(["why", "impll", "qa"], { cwd: () => dir });
    expect(code).toBe(1);
    expect(out).toContain("unknown phase");
  });

  test("why --json returns JSON", async () => {
    const { out } = await runCapture(["why", "impl", "qa", "--json"], { cwd: () => dir });
    const res = JSON.parse(out);
    expect(res.legal).toBe(true);
    expect(res.kind).toBe("direct");
  });

  test("why with wrong arity exits 1", async () => {
    const { code, err } = await runCapture(["why", "impl"], { cwd: () => dir });
    expect(code).toBe(1);
    expect(err).toContain("Usage:");
  });
});

function makeDriftDeps(cwd: string) {
  const logs: string[] = [];
  const errs: string[] = [];
  let exitCode: number | undefined;
  const deps = {
    loadManifest,
    bundleAlias,
    extractMetadata,
    hashFileSync,
    writeFileSync: (p: string, d: string) => writeFileSync(p, d, "utf-8"),
    readFileSync: (p: string) => readFileSync(p, "utf-8"),
    existsSync: (p: string) => existsSync(p),
    cwd: () => cwd,
    log: (m: string) => logs.push(m),
    logError: (m: string) => errs.push(m),
    exit: ((code: number) => {
      exitCode = code;
      throw new Error(`exit(${code})`);
    }) as (code: number) => never,
  };
  return { deps, logs, errs, getExitCode: () => exitCode };
}

describe("detectDrift", () => {
  async function installFixture(extraPhase?: { name: string; src: string }) {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    if (extraPhase) writeFileSync(join(dir, extraPhase.src), simpleAlias);
    const { deps } = makeDriftDeps(dir);
    await cmdPhase(["install"], deps);
  }

  test("reports no-lockfile when .mcx.lock is missing", () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("no-lockfile");
  });

  test("reports no-manifest when manifest is absent", async () => {
    await installFixture();
    rmSync(join(dir, ".mcx.yaml"));
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("no-manifest");
  });

  test("reports ok when nothing changed", async () => {
    await installFixture();
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("ok");
  }, 15_000);

  test("detects manifest drift", async () => {
    await installFixture();
    writeFileSync(join(dir, ".mcx.yaml"), `${simpleManifest}\n# change\n`);
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("drift");
    if (result.status === "drift") {
      expect(result.entries.some((e) => e.kind === "manifest")).toBe(true);
    }
  }, 15_000);

  test("detects phase source drift", async () => {
    await installFixture();
    writeFileSync(join(dir, "impl.ts"), `${simpleAlias}\n// mutated\n`);
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("drift");
    if (result.status === "drift") {
      const phase = result.entries.find((e) => e.kind === "phase-source");
      expect(phase).toBeDefined();
      expect(phase?.path).toBe("impl.ts");
    }
  }, 15_000);

  test("detects lockfile corruption as corrupt-lockfile", async () => {
    await installFixture();
    writeFileSync(join(dir, ".mcx.lock"), "{ not json");
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("drift");
    if (result.status === "drift") {
      expect(result.entries[0].kind).toBe("corrupt-lockfile");
    }
  }, 15_000);

  test("detects missing phase source file", async () => {
    await installFixture();
    rmSync(join(dir, "impl.ts"));
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("drift");
    if (result.status === "drift") {
      expect(result.entries.some((e) => e.kind === "phase-source" && e.actual.includes("missing"))).toBe(true);
    }
  }, 15_000);

  test("detects phase added to manifest after install", async () => {
    await installFixture();
    writeFileSync(join(dir, "qa.ts"), simpleAlias);
    const twoPhaseManifest = `initial: implement
phases:
  implement:
    source: ./impl.ts
    next: [qa]
  qa:
    source: ./qa.ts
    next: []
`;
    writeFileSync(join(dir, ".mcx.yaml"), twoPhaseManifest);
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("drift");
    if (result.status === "drift") {
      expect(result.entries.some((e) => e.kind === "phase-missing")).toBe(true);
    }
  }, 15_000);

  test("detects phase removed from manifest but still in lockfile", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const minimalManifest = "initial: other\nphases:\n  other:\n    source: ./impl.ts\n    next: []\n";
    writeFileSync(join(dir, ".mcx.yaml"), minimalManifest);
    const { deps } = makeDriftDeps(dir);
    const result = detectDrift(deps);
    expect(result.status).toBe("drift");
    if (result.status === "drift") {
      expect(result.entries.some((e) => e.kind === "phase-extra")).toBe(true);
    }
  }, 15_000);

  test("re-install clears drift", async () => {
    await installFixture();
    writeFileSync(join(dir, "impl.ts"), `${simpleAlias}\n// mutated\n`);
    const { deps: reDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], reDeps);
    const { deps: checkDeps } = makeDriftDeps(dir);
    expect(detectDrift(checkDeps).status).toBe("ok");
  }, 20_000);
});

describe("formatDriftWarning", () => {
  test("contains stern security-review language and the hashes", () => {
    const msg = formatDriftWarning([
      {
        kind: "manifest",
        path: ".mcx.yaml",
        expected: "a".repeat(64),
        actual: "b".repeat(64),
      },
      {
        kind: "phase-source",
        path: "phases/qa.ts",
        expected: "c".repeat(64),
        actual: "d".repeat(64),
      },
    ]);
    expect(msg).toContain("PHASE LOCKFILE DRIFT DETECTED");
    expect(msg).toContain("HASH MISMATCH");
    expect(msg).toContain("aaaaaa");
    expect(msg).toContain("bbbbbb");
    expect(msg).toContain("malicious PR");
    expect(msg).toContain("mcx phase install");
    expect(msg).not.toMatch(/run `mcx phase install` to fix/);
  });

  test("labels phase-missing as NOT INSTALLED", () => {
    const msg = formatDriftWarning([
      { kind: "phase-missing", path: "phases/qa.ts", expected: 'phase "qa" in lockfile', actual: "(not installed)" },
    ]);
    expect(msg).toContain("NOT INSTALLED");
  });

  test("labels phase-extra as STALE LOCK ENTRY", () => {
    const msg = formatDriftWarning([
      { kind: "phase-extra", path: "phases/old.ts", expected: "(not in manifest)", actual: 'phase "old" in lockfile' },
    ]);
    expect(msg).toContain("STALE LOCK ENTRY");
  });

  test("labels corrupt-lockfile as CORRUPT LOCKFILE", () => {
    const msg = formatDriftWarning([
      { kind: "corrupt-lockfile", path: ".mcx.lock", expected: "valid lockfile", actual: "Unexpected token" },
    ]);
    expect(msg).toContain("CORRUPT LOCKFILE");
  });

  test("truncates long non-hex actual values", () => {
    const longErr = "x".repeat(80);
    const msg = formatDriftWarning([
      { kind: "corrupt-lockfile", path: ".mcx.lock", expected: "valid lockfile", actual: longErr },
    ]);
    expect(msg).not.toContain(longErr);
    expect(msg).toContain("...");
  });
});

describe("parsePhaseLogArgs", () => {
  test("defaults to no filters", () => {
    expect(parsePhaseLogArgs([])).toEqual({ workItemId: null, forcedOnly: false, json: false });
  });

  test("parses flags", () => {
    expect(parsePhaseLogArgs(["--work-item", "#42", "--forced-only", "--json"])).toEqual({
      workItemId: "#42",
      forcedOnly: true,
      json: true,
    });
    expect(parsePhaseLogArgs(["--work-item=#99"])).toEqual({
      workItemId: "#99",
      forcedOnly: false,
      json: false,
    });
  });

  test("rejects unknown flag", () => {
    expect(() => parsePhaseLogArgs(["--nope"])).toThrow(/unknown argument/);
  });

  test("rejects bare --work-item", () => {
    expect(() => parsePhaseLogArgs(["--work-item"])).toThrow(/--work-item requires/);
  });

  test("rejects --work-item= with empty value", () => {
    expect(() => parsePhaseLogArgs(["--work-item="])).toThrow(/--work-item requires/);
  });
});

describe("filterTransitionLog", () => {
  const sample = [
    { ts: "t1", workItemId: "#1", from: null, to: "impl" },
    { ts: "t2", workItemId: "#2", from: null, to: "impl", forceMessage: "retry" },
    { ts: "t3", workItemId: "#1", from: "impl", to: "qa" },
  ];

  test("newest first by default", () => {
    expect(filterTransitionLog(sample, {}).map((e) => e.ts)).toEqual(["t3", "t2", "t1"]);
  });

  test("filters by workItemId", () => {
    expect(filterTransitionLog(sample, { workItemId: "#1" }).map((e) => e.ts)).toEqual(["t3", "t1"]);
  });

  test("forcedOnly keeps entries with forceMessage", () => {
    const r = filterTransitionLog(sample, { forcedOnly: true });
    expect(r.length).toBe(1);
    expect(r[0].forceMessage).toBe("retry");
  });
});

describe("formatTransitionLog", () => {
  test("renders header + rows with FORCED marker", () => {
    const out = formatTransitionLog([
      { ts: "2026-01-01T00:00:00Z", workItemId: "#1", from: "impl", to: "qa", forceMessage: "urgent" },
    ]);
    expect(out[0]).toContain("TIMESTAMP");
    expect(out[1]).toContain("impl → qa");
    expect(out[1]).toContain("FORCED: urgent");
  });

  test("truncates NOTE column at 60 chars with ellipsis", () => {
    const longMsg = "a".repeat(80);
    const out = formatTransitionLog([
      { ts: "2026-01-01T00:00:00Z", workItemId: "#1", from: "impl", to: "qa", forceMessage: longMsg },
    ]);
    const noteCell = out[1].slice(out[0].indexOf("NOTE")).trim();
    expect(noteCell.length).toBeLessThanOrEqual(60);
    expect(noteCell.endsWith("…")).toBe(true);
  });

  test("does not truncate NOTE shorter than 60 chars", () => {
    const out = formatTransitionLog([
      { ts: "2026-01-01T00:00:00Z", workItemId: "#1", from: "impl", to: "qa", forceMessage: "short msg" },
    ]);
    expect(out[1]).toContain("FORCED: short msg");
    expect(out[1]).not.toContain("…");
  });
});

describe("cmdPhase log", () => {
  test("prints nothing-recorded message when log is empty", async () => {
    const { deps, logs } = makeDriftDeps(dir);
    await cmdPhase(["log"], deps);
    expect(logs.some((l) => l.includes("no transitions recorded"))).toBe(true);
  });

  test("prints entries newest-first and honors --forced-only and --work-item", async () => {
    const log = transitionLogPath(dir);
    appendTransitionLog(log, { ts: "2026-01-01T00:00:00Z", workItemId: "#1", from: null, to: "impl" });
    appendTransitionLog(log, {
      ts: "2026-01-01T00:01:00Z",
      workItemId: "#2",
      from: null,
      to: "impl",
      forceMessage: "retry",
    });
    appendTransitionLog(log, { ts: "2026-01-01T00:02:00Z", workItemId: "#1", from: "impl", to: "qa" });

    const a = makeDriftDeps(dir);
    await cmdPhase(["log"], a.deps);
    expect(a.logs.length).toBe(4);
    expect(a.logs[1]).toContain("2026-01-01T00:02:00Z");

    const b = makeDriftDeps(dir);
    await cmdPhase(["log", "--forced-only"], b.deps);
    expect(b.logs.length).toBe(2);
    expect(b.logs[1]).toContain("FORCED: retry");

    const c = makeDriftDeps(dir);
    await cmdPhase(["log", "--work-item", "#1"], c.deps);
    expect(c.logs.length).toBe(3);
    expect(c.logs[1]).toContain("impl → qa");
    expect(c.logs[2]).toContain("(initial) → impl");
  });

  test("--json emits raw JSONL newest first", async () => {
    const log = transitionLogPath(dir);
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t2", workItemId: "#1", from: "impl", to: "qa", forceMessage: "x" });
    const { deps, logs } = makeDriftDeps(dir);
    await cmdPhase(["log", "--json"], deps);
    expect(logs.length).toBe(2);
    const first = JSON.parse(logs[0]);
    expect(first.ts).toBe("t2");
    expect(first.forceMessage).toBe("x");
  });

  test("--json + --work-item filters by work item and emits JSONL", async () => {
    const log = transitionLogPath(dir);
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t2", workItemId: "#2", from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t3", workItemId: "#1", from: "impl", to: "qa", forceMessage: "retry" });
    appendTransitionLog(log, { ts: "t4", workItemId: "#2", from: "impl", to: "qa" });
    const { deps, logs } = makeDriftDeps(dir);
    await cmdPhase(["log", "--json", "--work-item", "#1"], deps);
    expect(logs.length).toBe(2);
    const entries = logs.map((l) => JSON.parse(l));
    expect(entries[0].ts).toBe("t3");
    expect(entries[0].workItemId).toBe("#1");
    expect(entries[0].forceMessage).toBe("retry");
    expect(entries[1].ts).toBe("t1");
    expect(entries[1].workItemId).toBe("#1");
    expect(entries.every((e) => e.workItemId === "#1")).toBe(true);
  });
});

describe("cmdPhase check", () => {
  test("exits non-zero on drift with the stern warning", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    writeFileSync(join(dir, "impl.ts"), `${simpleAlias}\n// drift\n`);

    const { deps, errs, getExitCode } = makeDriftDeps(dir);
    await cmdPhase(["check"], deps).catch(() => {});
    expect(getExitCode()).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain("PHASE LOCKFILE DRIFT DETECTED");
    expect(joined).toContain("impl.ts");
  }, 20_000);

  test("exits zero with `lockfile ok` when clean", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    const { deps, logs, getExitCode } = makeDriftDeps(dir);
    await cmdPhase(["check"], deps);
    expect(getExitCode()).toBeUndefined();
    expect(logs.some((l) => l.includes("lockfile ok"))).toBe(true);
  }, 20_000);

  test("exits non-zero when lockfile is missing", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps, errs, getExitCode } = makeDriftDeps(dir);
    await cmdPhase(["check"], deps).catch(() => {});
    expect(getExitCode()).toBe(1);
    expect(errs.some((e) => e.includes("no .mcx.lock"))).toBe(true);
  });
});

describe("parsePhaseExecuteArgs", () => {
  test("extracts --arg pairs, leaves transition flags for parsePhaseRunArgs", () => {
    const parsed = parsePhaseExecuteArgs([
      "impl",
      "--from",
      "qa",
      "--work-item",
      "#42",
      "--arg",
      "provider=claude",
      "--arg",
      "labels=flaky",
    ]);
    expect(parsed.target).toBe("impl");
    expect(parsed.from).toBe("qa");
    expect(parsed.workItemId).toBe("#42");
    expect(parsed.args).toEqual({ provider: "claude", labels: "flaky" });
    expect(parsed.inputJson).toBeNull();
  });

  test("--input carries JSON payload", () => {
    const parsed = parsePhaseExecuteArgs(["impl", "--input", '{"provider":"copilot"}']);
    expect(parsed.inputJson).toBe('{"provider":"copilot"}');
  });

  test("--input=<json> equals form works", () => {
    const parsed = parsePhaseExecuteArgs(["impl", '--input={"x":1}']);
    expect(parsed.inputJson).toBe('{"x":1}');
  });

  test("--arg without = fails", () => {
    expect(() => parsePhaseExecuteArgs(["impl", "--arg", "noequals"])).toThrow(/key=val/);
  });

  test("--arg with empty key fails", () => {
    expect(() => parsePhaseExecuteArgs(["impl", "--arg", "=val"])).toThrow(/non-empty/);
  });
});

describe("executePhase (real handler dispatch, #1381)", () => {
  function makeExecDeps(opts: {
    branch?: string;
    workItem?: Record<string, unknown> | null;
    ipcRecord?: { calls: Array<{ method: string; params: unknown }> };
    stateStore?: Map<string, unknown>;
  }) {
    const branch = opts.branch ?? "main";
    const stateStore = opts.stateStore ?? new Map<string, unknown>();
    const calls = opts.ipcRecord?.calls ?? [];
    const ipcCall = async (method: string, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "getWorkItem":
          return opts.workItem ?? null;
        case "aliasStateGet": {
          const p = params as { namespace: string; key: string };
          return { value: stateStore.get(`${p.namespace}:${p.key}`) };
        }
        case "aliasStateSet": {
          const p = params as { namespace: string; key: string; value: unknown };
          stateStore.set(`${p.namespace}:${p.key}`, p.value);
          return { ok: true };
        }
        case "aliasStateDelete": {
          const p = params as { namespace: string; key: string };
          stateStore.delete(`${p.namespace}:${p.key}`);
          return { ok: true };
        }
        case "aliasStateAll":
          return { entries: {} };
        case "callTool": {
          const p = params as { server: string; tool: string; arguments: unknown };
          return { content: [{ type: "text", text: JSON.stringify({ server: p.server, tool: p.tool }) }] };
        }
        default:
          return null;
      }
    };
    const exec = (cmd: string[]) => {
      // Emulate git for branch-guard: `git -C <cwd> symbolic-ref --short HEAD`
      if (cmd.includes("rev-parse") && cmd.includes("--is-inside-work-tree")) {
        return { stdout: "true", exitCode: 0 };
      }
      if (cmd.includes("symbolic-ref")) {
        return { stdout: `${branch}\n`, exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    };
    return {
      ipcCall: ipcCall as unknown as typeof import("@mcp-cli/core").ipcCall,
      exec,
      findGitRoot: () => dir,
      now: () => new Date("2026-04-14T00:00:00Z"),
      stateStore,
      calls,
    };
  }

  const phaseAlias = `
import { defineAlias, z } from "mcp-cli";

defineAlias(({ z }) => ({
  name: "implement",
  description: "impl",
  input: z.object({ issue: z.number().optional() }).default({}),
  output: z.object({ action: z.string(), sessionId: z.string().optional() }),
  fn: async (input, ctx) => {
    const existing = await ctx.state.get("session_id");
    if (existing) {
      return { action: "in-flight", sessionId: String(existing) };
    }
    await ctx.state.set("session_id", "sess-123");
    await ctx.mcp._work_items.work_items_update({ id: ctx.workItem?.id ?? "none", phase: "impl" });
    return { action: "spawn", sessionId: "sess-123" };
  },
}));
`.trim();

  const manifestMain = `
runsOn: main
initial: implement
phases:
  implement:
    source: ./impl.ts
    next: []
`.trim();

  async function install() {
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
  }

  test("executes handler with real ctx and prints structured JSON to stdout", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestMain);
    writeFileSync(join(dir, "impl.ts"), phaseAlias);
    await install();

    const ex = makeExecDeps({
      workItem: {
        id: "#42",
        issueNumber: 42,
        prNumber: null,
        branch: "feat/42",
        prState: null,
        prUrl: null,
        ciStatus: "none",
        ciRunId: null,
        ciSummary: null,
        reviewStatus: "pending",
        phase: "implement",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const logs: string[] = [];
    const errs: string[] = [];
    await executePhase(
      ["implement", "--work-item", "#42"],
      {
        ...makeDriftDeps(dir).deps,
        log: (m) => logs.push(m),
        logError: (m) => errs.push(m),
        exit: ((c: number) => {
          throw new Error(`exit(${c})`);
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    );

    // Transition approval surfaced to stderr.
    expect(errs.some((e) => e.includes("approved") && e.includes("implement"))).toBe(true);
    // Structured handler return surfaced to stdout as JSON.
    const stdout = logs.join("\n");
    expect(stdout).toContain('"action": "spawn"');
    expect(stdout).toContain('"sessionId": "sess-123"');
    // State was persisted under workitem:<id>.
    expect(ex.stateStore.get("workitem:#42:session_id")).toBe("sess-123");
    // MCP proxy dispatched a callTool.
    const callToolInvocations = ex.calls.filter((c) => c.method === "callTool");
    expect(callToolInvocations.length).toBe(1);
    expect((callToolInvocations[0].params as { server: string }).server).toBe("_work_items");
  }, 30_000);

  test("re-entry is idempotent — returns in-flight when state already set", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestMain);
    writeFileSync(join(dir, "impl.ts"), phaseAlias);
    await install();

    const store = new Map<string, unknown>([["workitem:#42:session_id", "sess-existing"]]);
    const ex = makeExecDeps({
      workItem: {
        id: "#42",
        issueNumber: 42,
        prNumber: null,
        branch: "feat/42",
        prState: null,
        prUrl: null,
        ciStatus: "none",
        ciRunId: null,
        ciSummary: null,
        reviewStatus: "pending",
        phase: "implement",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      stateStore: store,
    });
    const logs: string[] = [];
    await executePhase(
      ["implement", "--work-item", "#42"],
      {
        ...makeDriftDeps(dir).deps,
        log: (m) => logs.push(m),
        logError: () => {},
        exit: ((c: number) => {
          throw new Error(`exit(${c})`);
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    );

    const stdout = logs.join("\n");
    expect(stdout).toContain('"action": "in-flight"');
    expect(stdout).toContain('"sessionId": "sess-existing"');
    // No MCP call on re-entry — handler took the short path.
    expect(ex.calls.some((c) => c.method === "callTool")).toBe(false);
  }, 30_000);

  test("branch guard fires when runsOn does not match current branch", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestMain);
    writeFileSync(join(dir, "impl.ts"), phaseAlias);
    await install();

    const ex = makeExecDeps({ branch: "feat/x" });
    const errs: string[] = [];
    let code: number | undefined;
    await executePhase(
      ["implement"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: (m) => errs.push(m),
        exit: ((c: number) => {
          code = c;
          throw new Error("exit");
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    ).catch(() => {});

    expect(code).toBe(1);
    expect(errs.some((e) => e.includes("phases only run from branch"))).toBe(true);
  }, 30_000);

  test("missing work item for --work-item id exits 1", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestMain);
    writeFileSync(join(dir, "impl.ts"), phaseAlias);
    await install();

    const ex = makeExecDeps({ workItem: null });
    const errs: string[] = [];
    let code: number | undefined;
    await executePhase(
      ["implement", "--work-item", "#999"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: (m) => errs.push(m),
        exit: ((c: number) => {
          code = c;
          throw new Error("exit");
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    ).catch(() => {});

    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('work item "#999" not found'))).toBe(true);
  }, 30_000);

  test("handler crash leaves only an 'attempted' entry — no committed transition (#1407)", async () => {
    const throwAlias = `
import { defineAlias, z } from "mcp-cli";
defineAlias(({ z }) => ({
  name: "implement",
  description: "impl",
  input: z.object({}).default({}),
  output: z.object({}),
  fn: async () => { throw new Error("handler boom"); },
}));
`.trim();
    writeFileSync(join(dir, ".mcx.yaml"), manifestMain);
    writeFileSync(join(dir, "impl.ts"), throwAlias);
    await install();

    const ex = makeExecDeps({});
    const errs: string[] = [];
    let code: number | undefined;
    await executePhase(
      ["implement"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: (m) => errs.push(m),
        exit: ((c: number) => {
          code = c;
          throw new Error("exit");
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    ).catch(() => {});

    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('phase "implement" failed'))).toBe(true);
    // "approved" is only logged on successful commit, never on crash.
    expect(errs.some((e) => e.includes("approved"))).toBe(false);
    // Log contains the attempted entry (audit trail) but NOT a committed one.
    const { readFileSync: rfs } = require("node:fs");
    const raw = rfs(join(dir, ".mcx", "transitions.jsonl"), "utf-8") as string;
    const entries = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { to: string; status?: string });
    const attempted = entries.filter((e) => e.status === "attempted");
    const committed = entries.filter((e) => e.status === "committed");
    expect(attempted.length).toBe(1);
    expect(attempted[0].to).toBe("implement");
    expect(committed.length).toBe(0);
  }, 30_000);

  test("back-to-back executePhase calls do not trip RegressionError (#1407)", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifestMain);
    writeFileSync(join(dir, "impl.ts"), phaseAlias);
    await install();

    const store = new Map<string, unknown>();
    const workItem = {
      id: "#42",
      issueNumber: 42,
      prNumber: null,
      branch: "feat/42",
      prState: null,
      prUrl: null,
      ciStatus: "none" as const,
      ciRunId: null,
      ciSummary: null,
      reviewStatus: "pending" as const,
      phase: "implement",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const run = async () => {
      const ex = makeExecDeps({ workItem, stateStore: store });
      const logs: string[] = [];
      const errs: string[] = [];
      let code: number | undefined;
      await executePhase(
        ["implement", "--work-item", "#42"],
        {
          ...makeDriftDeps(dir).deps,
          log: (m) => logs.push(m),
          logError: (m) => errs.push(m),
          exit: ((c: number) => {
            code = c;
            throw new Error(`exit(${c})`);
          }) as (code: number) => never,
        },
        { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
      ).catch(() => {});
      return { logs, errs, code };
    };

    const first = await run();
    expect(first.code).toBeUndefined();
    expect(first.logs.join("\n")).toContain('"action": "spawn"');

    // Second call on the same manifest/work-item must NOT throw
    // RegressionError. Handler self-checks state and returns "in-flight".
    const second = await run();
    expect(second.code).toBeUndefined();
    expect(second.errs.some((e) => e.toLowerCase().includes("regress"))).toBe(false);
    expect(second.logs.join("\n")).toContain('"action": "in-flight"');

    // Both runs committed to the log (idempotent self-loop allowed).
    const { readFileSync: rfs } = require("node:fs");
    const raw = rfs(join(dir, ".mcx", "transitions.jsonl"), "utf-8") as string;
    const entries = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { status?: string; to: string });
    expect(entries.filter((e) => e.status === "committed").length).toBe(2);
    expect(entries.filter((e) => e.status === "attempted").length).toBe(2);
  }, 30_000);

  test("falls back to work_items.phase when transition log is empty (#1522)", async () => {
    // Manifest with impl → triage flow (mirrors real sprint graph)
    const manifest = `
runsOn: main
initial: impl
phases:
  impl:
    source: ./impl.ts
    next: [triage]
  triage:
    source: ./triage.ts
    next: [done]
  done:
    source: ./impl.ts
    next: []
`.trim();
    const triageAlias = `
import { defineAlias, z } from "mcp-cli";
defineAlias(({ z }) => ({
  name: "triage",
  description: "triage",
  input: z.object({}).default({}),
  output: z.object({ action: z.string() }),
  fn: async () => ({ action: "done" }),
}));
`.trim();
    writeFileSync(join(dir, ".mcx.yaml"), manifest);
    writeFileSync(join(dir, "impl.ts"), phaseAlias);
    writeFileSync(join(dir, "triage.ts"), triageAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    // work_items.phase = "impl" but transition log is empty (impl was manually spawned)
    const ex = makeExecDeps({
      workItem: {
        id: "#1504",
        issueNumber: 1504,
        prNumber: null,
        branch: "feat/1504",
        prState: null,
        prUrl: null,
        ciStatus: "none",
        ciRunId: null,
        ciSummary: null,
        reviewStatus: "pending",
        phase: "impl",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const errs: string[] = [];
    let exitCode: number | undefined;
    await executePhase(
      ["triage", "--work-item", "#1504"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: (m) => errs.push(m),
        exit: ((c: number) => {
          exitCode = c;
          throw new Error(`exit(${c})`);
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    ).catch(() => {});

    // Must succeed: work_items.phase="impl" provides the implicit --from
    expect(exitCode).toBeUndefined();
    expect(errs.some((e) => e.includes("approved") && e.includes("impl") && e.includes("triage"))).toBe(true);
    expect(errs.some((e) => e.includes("(initial)"))).toBe(false);
  }, 30_000);

  test("ignores work_items.phase fallback when phase name not in manifest (#1636)", async () => {
    // Manifest uses "impl" but daemon returns a work item with phase="implement" (mismatched)
    // Should fall through to Rule 4 (initial enforcement) rather than UnknownPhaseError for "from"
    const noopAlias = `
import { defineAlias, z } from "mcp-cli";
defineAlias(({ z }) => ({
  name: "noop",
  description: "noop",
  input: z.object({}).default({}),
  output: z.object({ action: z.string() }),
  fn: async () => ({ action: "done" }),
}));
`.trim();
    writeFileSync(
      join(dir, ".mcx.yaml"),
      `
runsOn: main
initial: impl
phases:
  impl:
    source: ./impl2.ts
    next: [triage]
  triage:
    source: ./triage2.ts
    next: [done]
  done:
    source: ./impl2.ts
    next: []
`.trim(),
    );
    writeFileSync(join(dir, "impl2.ts"), noopAlias);
    writeFileSync(join(dir, "triage2.ts"), noopAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    // work_items.phase = "implement" is NOT in the manifest (manifest has "impl")
    const ex = makeExecDeps({
      workItem: {
        id: "#999",
        issueNumber: 999,
        prNumber: null,
        branch: "feat/999",
        prState: null,
        prUrl: null,
        ciStatus: "none",
        ciRunId: null,
        ciSummary: null,
        reviewStatus: "pending",
        phase: "implement",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    // validateTransition throws DisallowedTransitionError which propagates out of executePhase
    // (cmdPhase catches it; here we capture it directly)
    let caughtErr: unknown;
    await executePhase(
      ["triage", "--work-item", "#999"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: () => {},
        exit: (() => {
          throw new Error("exit");
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    ).catch((e) => {
      caughtErr = e;
    });

    // Must fail with DisallowedTransitionError "(initial) → triage", NOT UnknownPhaseError for "implement"
    expect(caughtErr).toBeInstanceOf(DisallowedTransitionError);
    expect(String(caughtErr)).toContain("(initial)");
    expect(String(caughtErr)).not.toContain("implement");
  }, 30_000);
});

describe("executePhase auto-persists work_items.phase (#1745)", () => {
  const triageAlias = `
import { defineAlias, z } from "mcp-cli";
defineAlias(({ z }) => ({
  name: "triage",
  description: "triage",
  input: z.object({}).default({}),
  output: z.object({ action: z.string() }),
  fn: async () => ({ action: "done" }),
}));
`.trim();

  const triageUpdatesPhase = `
import { defineAlias, z } from "mcp-cli";
defineAlias(({ z }) => ({
  name: "triage",
  description: "triage",
  input: z.object({}).default({}),
  output: z.object({ action: z.string() }),
  fn: async (_input, ctx) => {
    await ctx.mcp._work_items.work_items_update({ id: ctx.workItem?.id ?? "", phase: "triage" });
    return { action: "done" };
  },
}));
`.trim();

  const manifest = `
runsOn: main
initial: impl
phases:
  impl:
    source: ./impl.ts
    next: [triage]
  triage:
    source: ./triage.ts
    next: [done]
  done:
    source: ./impl.ts
    next: []
`.trim();

  const implAlias = `
import { defineAlias, z } from "mcp-cli";
defineAlias(({ z }) => ({
  name: "impl",
  description: "impl",
  input: z.object({}).default({}),
  output: z.object({ action: z.string() }),
  fn: async () => ({ action: "spawn" }),
}));
`.trim();

  function makeTrackingDeps(opts: { workItemPhase: string }) {
    let currentPhase = opts.workItemPhase;
    const calls: Array<{ method: string; params: unknown }> = [];
    const stateStore = new Map<string, unknown>();
    const ipcCall = async (method: string, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "getWorkItem":
          return {
            id: "#77",
            issueNumber: 77,
            prNumber: null,
            branch: "feat/77",
            prState: null,
            prUrl: null,
            ciStatus: "none",
            ciRunId: null,
            ciSummary: null,
            reviewStatus: "pending",
            phase: currentPhase,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        case "aliasStateGet": {
          const p = params as { namespace: string; key: string };
          return { value: stateStore.get(`${p.namespace}:${p.key}`) };
        }
        case "aliasStateSet": {
          const p = params as { namespace: string; key: string; value: unknown };
          stateStore.set(`${p.namespace}:${p.key}`, p.value);
          return { ok: true };
        }
        case "aliasStateDelete": {
          const p = params as { namespace: string; key: string };
          stateStore.delete(`${p.namespace}:${p.key}`);
          return { ok: true };
        }
        case "aliasStateAll":
          return { entries: {} };
        case "callTool": {
          const p = params as {
            server: string;
            tool: string;
            arguments: Record<string, unknown>;
            cwd?: string;
          };
          if (p.server === "_work_items" && p.tool === "work_items_update") {
            const legacyPhases = new Set(["impl", "review", "repair", "qa", "done"]);
            const nextPhase = String(p.arguments.phase ?? "");
            const repoRoot =
              (typeof p.arguments.repoRoot === "string" && p.arguments.repoRoot.length > 0
                ? p.arguments.repoRoot
                : null) ?? (typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : null);
            if (!legacyPhases.has(nextPhase) && repoRoot === null) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `work_items_update requires repoRoot when updating to non-legacy phase "${nextPhase}"`,
                  },
                ],
              };
            }
            if (nextPhase) {
              currentPhase = nextPhase;
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ server: p.server, tool: p.tool }) }] };
        }
        default:
          return null;
      }
    };
    const exec = (cmd: string[]) => {
      if (cmd.includes("rev-parse") && cmd.includes("--is-inside-work-tree")) {
        return { stdout: "true", exitCode: 0 };
      }
      if (cmd.includes("symbolic-ref")) {
        return { stdout: "main\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    };
    return {
      ipcCall: ipcCall as unknown as typeof import("@mcp-cli/core").ipcCall,
      exec,
      findGitRoot: () => dir,
      now: () => new Date("2026-04-14T00:00:00Z"),
      calls,
      getCurrentPhase: () => currentPhase,
    };
  }

  test("auto-updates work_items.phase when handler does not update it", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifest);
    writeFileSync(join(dir, "impl.ts"), implAlias);
    writeFileSync(join(dir, "triage.ts"), triageAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    // Seed transition log so impl→triage is valid
    appendTransitionLog(join(dir, ".mcx", "transitions.jsonl"), {
      workItemId: "#77",
      from: null,
      to: "impl",
      ts: "2026-04-14T00:00:00Z",
      status: "committed",
    });

    const ex = makeTrackingDeps({ workItemPhase: "impl" });
    await executePhase(
      ["triage", "--work-item", "#77"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: () => {},
        exit: ((c: number) => {
          throw new Error(`exit(${c})`);
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    );

    // The auto-update should have called work_items_update with phase=triage and repoRoot
    const updateCalls = ex.calls.filter(
      (c) =>
        c.method === "callTool" &&
        (c.params as { tool: string }).tool === "work_items_update" &&
        (c.params as { arguments: { phase: string } }).arguments.phase === "triage",
    );
    expect(updateCalls.length).toBe(1);
    const updateArgs = (updateCalls[0].params as { arguments: Record<string, unknown> }).arguments;
    expect(typeof updateArgs.repoRoot).toBe("string");
    expect((updateArgs.repoRoot as string).length).toBeGreaterThan(0);
    expect(ex.getCurrentPhase()).toBe("triage");
  }, 30_000);

  test("skips auto-update when handler already set phase to target", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), manifest);
    writeFileSync(join(dir, "impl.ts"), implAlias);
    writeFileSync(join(dir, "triage.ts"), triageUpdatesPhase);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);

    appendTransitionLog(join(dir, ".mcx", "transitions.jsonl"), {
      workItemId: "#77",
      from: null,
      to: "impl",
      ts: "2026-04-14T00:00:00Z",
      status: "committed",
    });

    const ex = makeTrackingDeps({ workItemPhase: "impl" });
    await executePhase(
      ["triage", "--work-item", "#77"],
      {
        ...makeDriftDeps(dir).deps,
        log: () => {},
        logError: () => {},
        exit: ((c: number) => {
          throw new Error(`exit(${c})`);
        }) as (code: number) => never,
      },
      { ipcCall: ex.ipcCall, exec: ex.exec, findGitRoot: ex.findGitRoot, now: ex.now },
    );

    // Handler itself called work_items_update → re-fetch sees phase=triage → no second update
    const updateCalls = ex.calls.filter(
      (c) => c.method === "callTool" && (c.params as { tool: string }).tool === "work_items_update",
    );
    // Only the handler's call, no auto-update
    expect(updateCalls.length).toBe(1);
    expect(ex.getCurrentPhase()).toBe("triage");
  }, 30_000);
});

describe("spawnExec (#1408)", () => {
  test("returns exitCode=1 and message when binary does not exist", () => {
    const result = spawnExec(["/nonexistent/binary/that/cannot/be/found"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("returns exitCode from successful process", () => {
    const result = spawnExec(["true"]);
    expect(result.exitCode).toBe(0);
  });

  test("returns exitCode=1 for failing process", () => {
    const result = spawnExec(["false"]);
    expect(result.exitCode).toBe(1);
  });
});
