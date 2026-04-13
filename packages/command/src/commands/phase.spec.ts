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
  bundleAlias,
  extractMetadata,
  hashFileSync,
  loadManifest,
  parseManifestText,
  validateManifest,
} from "@mcp-cli/core";
import {
  buildPhaseList,
  buildPhaseShow,
  checkStateSubset,
  cmdPhase,
  detectDrift,
  explainTransition,
  formatDriftWarning,
  formatPhaseTable,
  parsePhaseRunArgs,
  phaseRun,
  resolvePhaseSource,
  shortestPhasePath,
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

  test("run without --dry-run dispatches to transition enforcement", async () => {
    // Since #1293 merged, `run <target>` without --dry-run validates and records
    // the transition (transition-enforcement path), not the dry-run execution path.
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);
    const { deps: installDeps } = makeDriftDeps(dir);
    await cmdPhase(["install"], installDeps);
    const errs: string[] = [];
    let code: number | undefined;
    await cmdPhase(["run", "implement"], {
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
    // skip header; remaining rows should be alphabetical by name
    const names = lines.slice(1).map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("qa");
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
      // drift-check fires first; no-lockfile precedes no-manifest when both are absent
      expect(err).toContain("no .mcx.lock");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("run aborts with drift warning when phase source is tampered", async () => {
    // Mutate a phase source after install — drift check must block dispatch
    writeFileSync(join(dir, "qa.ts"), `${readFileSync(join(dir, "qa.ts"), "utf-8")}\n// tampered\n`);
    const { code, err } = await withCwd(dir, () => catchExit(() => cmdPhase(["run", "qa", "--from", "impl"])));
    expect(code).toBe(1);
    expect(err).toContain("PHASE LOCKFILE DRIFT DETECTED");
    expect(err).toContain("qa.ts");
  });

  test("run --dry-run aborts on drift before dispatch", async () => {
    writeFileSync(join(dir, "qa.ts"), `${readFileSync(join(dir, "qa.ts"), "utf-8")}\n// tampered\n`);
    const { code, err } = await withCwd(dir, () => catchExit(() => cmdPhase(["run", "qa", "--dry-run"])));
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

  async function withCwd<T>(newCwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.cwd();
    process.chdir(newCwd);
    try {
      return await fn();
    } finally {
      process.chdir(prev);
    }
  }

  async function runCapture(args: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
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
      await cmdPhase(args).catch((e) => {
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
    const { out } = await withCwd(dir, () => runCapture(["list"]));
    expect(out).toContain("NAME");
    expect(out).toContain("SOURCE");
    expect(out).toContain("STATUS");
    expect(out).toContain("NEXT");
    expect(out).toContain("impl");
    expect(out).toContain("missing");
  });

  test("list --json emits structured output", async () => {
    const { out } = await withCwd(dir, () => runCapture(["list", "--json"]));
    const rows = JSON.parse(out);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty("name");
    expect(rows[0]).toHaveProperty("status");
    expect(rows[0]).toHaveProperty("next");
  });

  test("show prints phase details", async () => {
    const { out, code } = await withCwd(dir, () => runCapture(["show", "impl"]));
    expect(code).toBeUndefined();
    expect(out).toContain("phase: impl");
    expect(out).toContain("source: ./impl.ts");
    expect(out).toContain("next:");
    expect(out).toContain("adversarial-review");
  });

  test("show on unknown phase exits 1 with suggestions", async () => {
    const { code, err } = await withCwd(dir, () => runCapture(["show", "impll"]));
    expect(code).toBe(1);
    expect(err).toContain("unknown phase");
    expect(err).toContain("impl");
  });

  test("show --json returns JSON", async () => {
    const { out } = await withCwd(dir, () => runCapture(["show", "impl", "--json"]));
    const info = JSON.parse(out);
    expect(info.name).toBe("impl");
    expect(info.next).toContain("qa");
  });

  test("show without name exits 1", async () => {
    const { code, err } = await withCwd(dir, () => runCapture(["show"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage:");
  });

  test("why reports direct transitions", async () => {
    const { out, code } = await withCwd(dir, () => runCapture(["why", "impl", "qa"]));
    expect(code).toBeUndefined();
    expect(out).toContain("approved direct transition");
  });

  test("why reports indirect transitions", async () => {
    const { out, code } = await withCwd(dir, () => runCapture(["why", "impl", "done"]));
    expect(code).toBeUndefined();
    expect(out).toContain("shortest legal path");
    expect(out).toContain("qa");
  });

  test("why reports regression with exit 1", async () => {
    const { out, code } = await withCwd(dir, () => runCapture(["why", "done", "impl"]));
    expect(code).toBe(1);
    expect(out).toContain("regress");
  });

  test("why reports unknown phase with exit 1", async () => {
    const { out, code } = await withCwd(dir, () => runCapture(["why", "impll", "qa"]));
    expect(code).toBe(1);
    expect(out).toContain("unknown phase");
  });

  test("why --json returns JSON", async () => {
    const { out } = await withCwd(dir, () => runCapture(["why", "impl", "qa", "--json"]));
    const res = JSON.parse(out);
    expect(res.legal).toBe(true);
    expect(res.kind).toBe("direct");
  });

  test("why with wrong arity exits 1", async () => {
    const { code, err } = await withCwd(dir, () => runCapture(["why", "impl"]));
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
