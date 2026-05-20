import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { AuditResult, CmdMemoryDeps, MemoryDeps } from "./memory";
import { buildPrompt, cmdMemory, defaultDeps, findMemoryDir, parseHaikuResponse, runMemoryAudit } from "./memory";

// ─── findMemoryDir ────────────────────────────────────────────────────────────

describe("findMemoryDir", () => {
  test("returns path when .claude/memory exists at git root", () => {
    const deps = {
      getGitRoot: () => "/repo",
      cwd: () => "/repo/sub",
      dirExists: () => true,
    };
    expect(findMemoryDir(deps)).toBe("/repo/.claude/memory");
  });

  test("returns null when directory does not exist", () => {
    const deps = {
      getGitRoot: () => "/repo",
      cwd: () => "/repo",
      dirExists: () => false,
    };
    expect(findMemoryDir(deps)).toBeNull();
  });

  test("uses cwd when git root is null", () => {
    const deps = {
      getGitRoot: () => null,
      cwd: () => "/myproject",
      dirExists: (path: string) => path === "/myproject/.claude/memory",
    };
    expect(findMemoryDir(deps)).toBe("/myproject/.claude/memory");
  });
});

// ─── buildPrompt ──────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("includes memory index in prompt", () => {
    const prompt = buildPrompt(
      "/repo/.claude/memory",
      "# Memory Index\n- [foo](foo.md) — bar",
      [{ name: "foo.md", content: "rule content" }],
      "closed issues list",
    );
    expect(prompt).toContain("# Memory Index");
    expect(prompt).toContain("foo.md");
    expect(prompt).toContain("rule content");
    expect(prompt).toContain("closed issues list");
  });

  test("uses placeholder when no rule files", () => {
    const prompt = buildPrompt("/repo/.claude/memory", "index", [], "issues");
    expect(prompt).toContain("(no rule files found)");
  });
});

// ─── parseHaikuResponse ───────────────────────────────────────────────────────

describe("parseHaikuResponse", () => {
  const validResult: AuditResult = {
    findings: [
      {
        file: "feedback_foo.md",
        status: "load-bearing",
        reason: "Still needed.",
        related: null,
      },
      {
        file: "feedback_bar.md",
        status: "stale",
        reason: "Issue #42 shipped.",
        related: null,
      },
    ],
    top_prune_candidates: ["feedback_bar.md"],
  };

  test("parses bare JSON", () => {
    expect(parseHaikuResponse(JSON.stringify(validResult))).toEqual(validResult);
  });

  test("parses JSON wrapped in markdown code fences", () => {
    const fenced = `\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\``;
    expect(parseHaikuResponse(fenced)).toEqual(validResult);
  });

  test("parses JSON with unlabeled code fences", () => {
    const fenced = `\`\`\`\n${JSON.stringify(validResult)}\n\`\`\``;
    expect(parseHaikuResponse(fenced)).toEqual(validResult);
  });

  test("skips leading prose before first {", () => {
    const withProse = `Here is the result:\n${JSON.stringify(validResult)}`;
    expect(parseHaikuResponse(withProse)).toEqual(validResult);
  });

  test("returns null for invalid JSON", () => {
    expect(parseHaikuResponse("not json at all")).toBeNull();
  });

  test("returns null for JSON that starts with { but is malformed", () => {
    expect(parseHaikuResponse("{not valid json}")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseHaikuResponse("")).toBeNull();
  });
});

// ─── runMemoryAudit ───────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<MemoryDeps> = {}): MemoryDeps & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];

  const auditResult: AuditResult = {
    findings: [
      { file: "feedback_test.md", status: "load-bearing", reason: "Still needed.", related: null },
      { file: "feedback_old.md", status: "stale", reason: "Fixed in #99.", related: null },
    ],
    top_prune_candidates: ["feedback_old.md"],
  };

  return {
    logs,
    errors,
    getGitRoot: () => "/repo",
    cwd: () => "/repo",
    dirExists: () => true,
    spawnCapture: (cmd) => {
      if (cmd[0] === "gh") {
        return JSON.stringify([{ number: 99, title: "Fix old rule", closedAt: "2026-01-01T00:00:00Z" }]);
      }
      if (cmd.some((s) => s.includes("claude"))) {
        return JSON.stringify(auditResult);
      }
      return null;
    },
    readFile: (path) => {
      if (path.endsWith("MEMORY.md")) return "# Memory\n- [feedback_test](feedback_test.md)";
      if (path.endsWith("feedback_test.md")) return "---\nname: test\n---\nrule content";
      if (path.endsWith("feedback_old.md")) return "---\nname: old\n---\nold content";
      return null;
    },
    listFiles: (_, ext) => {
      if (ext === ".md") return ["feedback_test.md", "feedback_old.md", "MEMORY.md"];
      return [];
    },
    findClaudeBinary: () => "/usr/bin/claude",
    log: (msg) => logs.push(msg),
    logError: (msg) => errors.push(msg),
    exit: (code) => {
      throw new Error(`exit(${code})`);
    },
    ...overrides,
  };
}

describe("runMemoryAudit", () => {
  test("text mode prints findings and prune candidates", async () => {
    const deps = makeDeps();
    await runMemoryAudit({ json: false }, deps);
    const output = deps.logs.join("\n");
    expect(output).toContain("feedback_test.md");
    expect(output).toContain("feedback_old.md");
    expect(output).toContain("Top prune candidates");
    expect(output).toContain("feedback_old.md");
  });

  test("json mode prints valid JSON result", async () => {
    const deps = makeDeps();
    await runMemoryAudit({ json: true }, deps);
    expect(deps.logs.length).toBe(1);
    const parsed = JSON.parse(deps.logs[0]) as AuditResult;
    expect(parsed.findings).toBeArray();
    expect(parsed.top_prune_candidates).toBeArray();
  });

  test("exits with error when no memory directory found", async () => {
    const deps = makeDeps({
      getGitRoot: () => null,
      cwd: () => "/nonexistent",
      dirExists: () => false,
    });
    await expect(runMemoryAudit({ json: false }, deps)).rejects.toThrow("exit(1)");
  });

  test("exits when claude binary not found", async () => {
    const deps = makeDeps({ findClaudeBinary: () => null });
    await expect(runMemoryAudit({ json: false }, deps)).rejects.toThrow("exit(1)");
  });

  test("exits when Haiku returns null", async () => {
    const deps = makeDeps({
      spawnCapture: (cmd) => {
        if (cmd[0] === "gh") return "[]";
        return null; // claude returns null
      },
    });
    await expect(runMemoryAudit({ json: false }, deps)).rejects.toThrow("exit(1)");
  });

  test("exits when Haiku returns unparseable response", async () => {
    const deps = makeDeps({
      spawnCapture: (cmd) => {
        if (cmd[0] === "gh") return "[]";
        return "I cannot help with that."; // not JSON
      },
    });
    await expect(runMemoryAudit({ json: false }, deps)).rejects.toThrow("exit(1)");
  });

  test("handles malformed gh JSON gracefully", async () => {
    const result: AuditResult = {
      findings: [{ file: "feedback_test.md", status: "load-bearing", reason: "ok", related: null }],
      top_prune_candidates: [],
    };
    const deps = makeDeps({
      spawnCapture: (cmd) => {
        if (cmd[0] === "gh") return "{malformed json}"; // parse error in fetchClosedIssues
        if (cmd.some((s) => s.includes("claude"))) return JSON.stringify(result);
        return null;
      },
    });
    await runMemoryAudit({ json: false }, deps);
    // Should still complete even with broken gh output
    expect(deps.logs.join("\n")).toContain("feedback_test.md");
  });

  test("text mode reports 'No prune candidates' when list is empty", async () => {
    const result: AuditResult = {
      findings: [{ file: "feedback_test.md", status: "load-bearing", reason: "Still good.", related: null }],
      top_prune_candidates: [],
    };
    const deps = makeDeps({
      spawnCapture: (cmd) => {
        if (cmd[0] === "gh") return "[]";
        if (cmd.some((s) => s.includes("claude"))) return JSON.stringify(result);
        return null;
      },
    });
    await runMemoryAudit({ json: false }, deps);
    expect(deps.logs.join("\n")).toContain("No prune candidates");
  });
});

// ─── cmdMemory ────────────────────────────────────────────────────────────────

describe("cmdMemory", () => {
  function makeCmdDeps(overrides: Partial<CmdMemoryDeps> = {}): CmdMemoryDeps & { logs: string[] } {
    const logs: string[] = [];
    return {
      logs,
      exit: (code) => {
        throw new Error(`exit(${code})`);
      },
      log: (msg) => logs.push(msg),
      runAudit: async () => {},
      makeDeps: () => makeDeps(),
      ...overrides,
    };
  }

  test("prints help when no subcommand", async () => {
    const d = makeCmdDeps();
    await cmdMemory([], d);
    expect(d.logs.join("\n")).toContain("mcx memory audit");
  });

  test("prints help with --help flag", async () => {
    const d = makeCmdDeps();
    await cmdMemory(["--help"], d);
    expect(d.logs.join("\n")).toContain("mcx memory audit");
  });

  test("prints help with -h flag", async () => {
    const d = makeCmdDeps();
    await cmdMemory(["-h"], d);
    expect(d.logs.join("\n")).toContain("mcx memory audit");
  });

  test("exits with error for unknown subcommand", async () => {
    const d = makeCmdDeps();
    await expect(cmdMemory(["unknown"], d)).rejects.toThrow("exit(1)");
  });

  test("calls runAudit with json=false for audit", async () => {
    const calls: Array<{ json: boolean }> = [];
    const d = makeCmdDeps({
      runAudit: async (opts) => {
        calls.push(opts);
      },
    });
    await cmdMemory(["audit"], d);
    expect(calls).toEqual([{ json: false }]);
  });

  test("calls runAudit with json=true for audit --json", async () => {
    const calls: Array<{ json: boolean }> = [];
    const d = makeCmdDeps({
      runAudit: async (opts) => {
        calls.push(opts);
      },
    });
    await cmdMemory(["audit", "--json"], d);
    expect(calls).toEqual([{ json: true }]);
  });

  test("exits with error for unknown flags", async () => {
    const d = makeCmdDeps();
    await expect(cmdMemory(["audit", "--unknown-flag"], d)).rejects.toThrow("exit(1)");
  });
});

// ─── defaultDeps (safe I/O methods) ───────────────────────────────────────────

describe("defaultDeps", () => {
  const deps = defaultDeps();

  test("cwd() returns a non-empty string", () => {
    expect(typeof deps.cwd()).toBe("string");
    expect(deps.cwd().length).toBeGreaterThan(0);
  });

  test("dirExists() returns true for existing path and false for missing", () => {
    expect(deps.dirExists(import.meta.dir)).toBe(true);
    expect(deps.dirExists("/this/path/does/not/exist/ever")).toBe(false);
  });

  test("readFile() reads a real file", () => {
    const content = deps.readFile(import.meta.path);
    expect(content).not.toBeNull();
    expect(content).toContain("defaultDeps");
  });

  test("readFile() returns null for missing file", () => {
    expect(deps.readFile("/no/such/file.md")).toBeNull();
  });

  test("listFiles() returns .ts files in this directory", () => {
    const files = deps.listFiles(import.meta.dir, ".ts");
    expect(files).toContain("memory.spec.ts");
    expect(files).toContain("memory.ts");
  });

  test("listFiles() returns [] for missing directory", () => {
    expect(deps.listFiles("/no/such/dir", ".md")).toEqual([]);
  });

  test("getGitRoot() returns the repo root (we are in a git repo)", () => {
    const root = deps.getGitRoot();
    expect(root).not.toBeNull();
    expect(existsSync(`${root}/.git`) || existsSync(`${root}/../.git`)).toBe(true);
  });
});
