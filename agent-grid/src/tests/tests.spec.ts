import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getProvider } from "@mcp-cli/core";
import type { AgentProvider } from "@mcp-cli/core";
import { gateTest } from "../capability-gate";
import { makeEditFileTest } from "./edit-file";
import type { CallToolFn } from "./helpers";
import { byeSession, extractSessionId, extractText, promptAndWait, promptFollowUp, promptNoWait } from "./helpers";
import { makeMultiTurnTest } from "./multi-turn";
import { makeReadFileTest } from "./read-file";
import { makeRunBashTest } from "./run-bash";
import { makeSpawnInDirTest } from "./spawn-in-dir";

function requireProvider(name: string): AgentProvider {
  const p = getProvider(name);
  if (!p) throw new Error(`provider "${name}" not registered`);
  return p;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grid-test-spec-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function mcpTextResult(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function mcpPromptResult(sessionId: string, resultText: string): unknown {
  return mcpTextResult(JSON.stringify({ sessionId, success: true, text: resultText }));
}

const stubCallTool: CallToolFn = async () => mcpPromptResult("stub-session", "stub");

// ── extractText ───────────────────────────────────────────────────

describe("extractText", () => {
  test("extracts text from MCP content array", () => {
    const raw = { content: [{ type: "text", text: "hello world" }] };
    expect(extractText(raw)).toBe("hello world");
  });

  test("joins multiple content items", () => {
    const raw = {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(extractText(raw)).toBe("a\nb");
  });

  test("returns JSON for non-content shape", () => {
    expect(extractText({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  test("returns string for primitive", () => {
    expect(extractText(null)).toBe("null");
    expect(extractText(42)).toBe("42");
  });
});

// ── extractSessionId ─────────────────────────────────────────────

describe("extractSessionId", () => {
  test("extracts from JSON", () => {
    expect(extractSessionId('{"sessionId": "abc-123", "ok": true}')).toBe("abc-123");
  });

  test("extracts from Python repr (single-quoted)", () => {
    expect(extractSessionId("{'sessionId': 'py-456', 'ok': True}")).toBe("py-456");
  });

  test("extracts via regex fallback for embedded JSON", () => {
    expect(extractSessionId('some preamble "sessionId": "fallback-id" and more')).toBe("fallback-id");
  });

  test("extracts via regex fallback for embedded Python repr", () => {
    expect(extractSessionId("some preamble 'sessionId': 'py-fallback' and more")).toBe("py-fallback");
  });

  test("returns empty string when no sessionId", () => {
    expect(extractSessionId("no session info here")).toBe("");
  });
});

// ── promptAndWait ─────────────────────────────────────────────────

describe("promptAndWait", () => {
  const claude = requireProvider("claude");

  test("extracts sessionId from JSON response", async () => {
    const callTool: CallToolFn = async () => mcpPromptResult("abc-123", "hello");
    const result = await promptAndWait(claude, { task: "test", cwd: "/tmp", callTool });
    expect(result.sessionId).toBe("abc-123");
    expect(result.text).toContain("abc-123");
  });

  test("throws on error result", async () => {
    const callTool: CallToolFn = async () => mcpTextResult("something broke", true);
    expect(promptAndWait(claude, { task: "test", cwd: "/tmp", callTool })).rejects.toThrow("prompt failed");
  });

  test("extracts sessionId from regex fallback", async () => {
    const callTool: CallToolFn = async () => mcpTextResult('some preamble "sessionId": "fallback-id" and more');
    const result = await promptAndWait(claude, { task: "test", cwd: "/tmp", callTool });
    expect(result.sessionId).toBe("fallback-id");
  });

  test("extracts sessionId from Python repr response", async () => {
    const callTool: CallToolFn = async () => mcpTextResult("{'sessionId': 'py-sess-1', 'success': True}");
    const result = await promptAndWait(claude, { task: "test", cwd: "/tmp", callTool });
    expect(result.sessionId).toBe("py-sess-1");
  });

  test("throws when no sessionId found", async () => {
    const callTool: CallToolFn = async () => mcpTextResult("no session info here");
    expect(promptAndWait(claude, { task: "test", cwd: "/tmp", callTool })).rejects.toThrow("no sessionId");
  });

  test("calls correct tool with correct args", async () => {
    let capturedServer = "";
    let capturedTool = "";
    let capturedArgs: Record<string, unknown> = {};
    const callTool: CallToolFn = async (server, tool, args) => {
      capturedServer = server;
      capturedTool = tool;
      capturedArgs = args;
      return mcpPromptResult("s1", "ok");
    };
    await promptAndWait(claude, { task: "do stuff", cwd: "/my/dir", callTool });
    expect(capturedServer).toBe("_claude");
    expect(capturedTool).toBe("claude_prompt");
    expect(capturedArgs.prompt).toBe("do stuff");
    expect(capturedArgs.cwd).toBe("/my/dir");
    expect(capturedArgs.wait).toBe(true);
  });
});

// ── promptNoWait ──────────────────────────────────────────────────

describe("promptNoWait", () => {
  const claude = requireProvider("claude");

  test("extracts sessionId", async () => {
    const callTool: CallToolFn = async () => mcpTextResult(JSON.stringify({ sessionId: "nw-1", seq: 0 }));
    const result = await promptNoWait(claude, { task: "test", cwd: "/tmp", callTool });
    expect(result.sessionId).toBe("nw-1");
  });

  test("throws on error result", async () => {
    const callTool: CallToolFn = async () => mcpTextResult("error", true);
    expect(promptNoWait(claude, { task: "test", cwd: "/tmp", callTool })).rejects.toThrow("prompt failed");
  });

  test("throws when no sessionId returned", async () => {
    const callTool: CallToolFn = async () => mcpTextResult("plain text no session");
    expect(promptNoWait(claude, { task: "test", cwd: "/tmp", callTool })).rejects.toThrow("no sessionId");
  });

  test("does not send wait flag", async () => {
    let capturedArgs: Record<string, unknown> = {};
    const callTool: CallToolFn = async (_s, _t, args) => {
      capturedArgs = args;
      return mcpTextResult(JSON.stringify({ sessionId: "nw-2", seq: 0 }));
    };
    await promptNoWait(claude, { task: "test", cwd: "/tmp", callTool });
    expect(capturedArgs.wait).toBeUndefined();
  });
});

// ── promptFollowUp ────────────────────────────────────────────────

describe("promptFollowUp", () => {
  const claude = requireProvider("claude");

  test("sends sessionId in args", async () => {
    let capturedArgs: Record<string, unknown> = {};
    const callTool: CallToolFn = async (_s, _t, args) => {
      capturedArgs = args;
      return mcpPromptResult("fu-1", "response");
    };
    const result = await promptFollowUp(claude, { sessionId: "fu-1", task: "follow", cwd: "/tmp", callTool });
    expect(result.sessionId).toBe("fu-1");
    expect(capturedArgs.sessionId).toBe("fu-1");
    expect(capturedArgs.wait).toBe(true);
  });

  test("throws on error result", async () => {
    const callTool: CallToolFn = async () => mcpTextResult("bad", true);
    expect(promptFollowUp(claude, { sessionId: "fu-1", task: "test", cwd: "/tmp", callTool })).rejects.toThrow(
      "follow-up prompt failed",
    );
  });
});

// ── byeSession ────────────────────────────────────────────────────

describe("byeSession", () => {
  test("calls bye tool with correct args", async () => {
    let capturedTool = "";
    let capturedArgs: Record<string, unknown> = {};
    const callTool: CallToolFn = async (_s, tool, args) => {
      capturedTool = tool;
      capturedArgs = args;
      return mcpTextResult("ok");
    };
    await byeSession(requireProvider("claude"), "sess-bye", callTool);
    expect(capturedTool).toBe("claude_bye");
    expect(capturedArgs.sessionId).toBe("sess-bye");
  });
});

// ── test registry ─────────────────────────────────────────────────

function buildAllTests(callTool: CallToolFn) {
  return [
    makeSpawnInDirTest({ callTool }),
    makeReadFileTest({ callTool }),
    makeEditFileTest({ callTool }),
    makeRunBashTest({ callTool }),
    makeMultiTurnTest({ callTool }),
  ];
}

describe("test registry", () => {
  const tests = buildAllTests(stubCallTool);

  test("contains exactly 5 tests", () => {
    expect(tests).toHaveLength(5);
  });

  test("test names are unique", () => {
    const names = tests.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("expected test names are present", () => {
    const names = tests.map((t) => t.name);
    expect(names).toContain("spawn-in-dir");
    expect(names).toContain("read-file");
    expect(names).toContain("edit-file");
    expect(names).toContain("run-bash");
    expect(names).toContain("multi-turn");
  });
});

// ── Test structure and gating ─────────────────────────────────────

describe("spawn-in-dir", () => {
  const test_ = makeSpawnInDirTest({ callTool: stubCallTool });

  test("has correct name and requires", () => {
    expect(test_.name).toBe("spawn-in-dir");
    expect(test_.requires).toEqual([]);
  });

  test("not gated for claude", () => {
    expect(gateTest(test_, requireProvider("claude"))).toBeNull();
  });

  test("not gated for codex", () => {
    expect(gateTest(test_, requireProvider("codex"))).toBeNull();
  });

  test("passes when response includes resolved cwd", async () => {
    const cwd = makeTmpDir();
    const expected = Bun.spawnSync(["realpath", cwd]).stdout.toString().trim();

    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", expected);
    };
    const t = makeSpawnInDirTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("pass");
  });

  test("passes when response includes unresolved cwd", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", cwd);
    };
    const t = makeSpawnInDirTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("pass");
  });

  test("fails when response does not include cwd", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", "/some/other/path");
    };
    const t = makeSpawnInDirTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
  });

  test("registers onCleanup", async () => {
    const cwd = makeTmpDir();
    let cleanupRegistered = false;
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", cwd);
    };
    const t = makeSpawnInDirTest({ callTool });
    await t.run({
      provider: requireProvider("claude"),
      cwd,
      onCleanup: () => {
        cleanupRegistered = true;
      },
    });
    expect(cleanupRegistered).toBe(true);
  });
});

describe("read-file", () => {
  const test_ = makeReadFileTest({ callTool: stubCallTool });

  test("has correct name and requires", () => {
    expect(test_.name).toBe("read-file");
    expect(test_.requires).toEqual([]);
  });

  test("passes when response includes marker", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", "GRID_READ_MARKER_7f3a");
    };
    const t = makeReadFileTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("pass");
    expect(existsSync(join(cwd, "grid-test-read.txt"))).toBe(true);
  });

  test("fails when response lacks marker", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", "some other text");
    };
    const t = makeReadFileTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
  });
});

describe("edit-file", () => {
  const test_ = makeEditFileTest({ callTool: stubCallTool });

  test("has correct name and requires", () => {
    expect(test_.name).toBe("edit-file");
    expect(test_.requires).toEqual([]);
  });

  test("passes when callTool simulates a successful edit", async () => {
    const cwd = makeTmpDir();
    const filePath = join(cwd, "grid-test-edit.txt");

    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_prompt")) {
        const content = readFileSync(filePath, "utf-8");
        writeFileSync(filePath, content.replace("GRID_EDIT_ORIGINAL_4d9e", "GRID_EDIT_MODIFIED_4d9e"));
        return mcpPromptResult("sess-1", "done");
      }
      return mcpTextResult("ok");
    };

    const t = makeEditFileTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("pass");
  });

  test("fails when file not modified", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", "done");
    };
    const t = makeEditFileTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
  });
});

describe("run-bash", () => {
  const test_ = makeRunBashTest({ callTool: stubCallTool });

  test("has correct name and requires", () => {
    expect(test_.name).toBe("run-bash");
    expect(test_.requires).toEqual([]);
  });

  test("passes when bash creates proof file with marker", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_prompt")) {
        writeFileSync(join(cwd, "grid-bash-proof.txt"), "GRID_BASH_PROOF_9c4f\n");
        return mcpPromptResult("sess-1", "done");
      }
      return mcpTextResult("ok");
    };
    const t = makeRunBashTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("pass");
  });

  test("fails when proof file not created", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_s, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpPromptResult("sess-1", "done");
    };
    const t = makeRunBashTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
    expect((result as { error: string }).error).toContain("was not created");
  });

  test("fails when proof file has wrong content", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_prompt")) {
        writeFileSync(join(cwd, "grid-bash-proof.txt"), "wrong content");
        return mcpPromptResult("sess-1", "done");
      }
      return mcpTextResult("ok");
    };
    const t = makeRunBashTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
    expect((result as { error: string }).error).toContain("missing marker");
  });

  test("registers onCleanup", async () => {
    const cwd = makeTmpDir();
    let cleanupRegistered = false;
    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_prompt")) {
        writeFileSync(join(cwd, "grid-bash-proof.txt"), "GRID_BASH_PROOF_9c4f\n");
        return mcpPromptResult("sess-1", "done");
      }
      return mcpTextResult("ok");
    };
    const t = makeRunBashTest({ callTool });
    await t.run({
      provider: requireProvider("claude"),
      cwd,
      onCleanup: () => {
        cleanupRegistered = true;
      },
    });
    expect(cleanupRegistered).toBe(true);
  });
});

describe("multi-turn", () => {
  const test_ = makeMultiTurnTest({ callTool: stubCallTool });

  test("has correct name and requires", () => {
    expect(test_.name).toBe("multi-turn");
    expect(test_.requires).toEqual(["multiTurn"]);
  });

  test("gated for providers lacking multiTurn", () => {
    const provider = { ...requireProvider("claude"), native: {} };
    const result = gateTest(test_, provider);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("n/a");
  });

  test("not gated for claude", () => {
    expect(gateTest(test_, requireProvider("claude"))).toBeNull();
  });

  test("passes with simulated multi-turn conversation", async () => {
    const cwd = makeTmpDir();
    let callCount = 0;

    const callTool: CallToolFn = async (_server, tool, args) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      callCount++;
      if (callCount === 1) {
        return mcpPromptResult("sess-mt", "OK");
      }
      if (callCount === 2) {
        return mcpPromptResult("sess-mt", "GRID_MULTI_8b2c");
      }
      if (callCount === 3) {
        writeFileSync(join(cwd, "multi-turn-proof.txt"), "GRID_MULTI_8b2c");
        return mcpPromptResult("sess-mt", "done");
      }
      return mcpPromptResult("sess-mt", "unexpected");
    };

    const t = makeMultiTurnTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("pass");
  });

  test("throws when no sessionId from turn 1", async () => {
    const cwd = makeTmpDir();
    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      return mcpTextResult("plain text no session id");
    };
    const t = makeMultiTurnTest({ callTool });
    expect(t.run({ provider: requireProvider("claude"), cwd })).rejects.toThrow("no sessionId");
  });

  test("fails when proof file not created", async () => {
    const cwd = makeTmpDir();
    let callCount = 0;
    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      callCount++;
      if (callCount === 1) return mcpPromptResult("sess-mt", "OK");
      if (callCount === 2) return mcpPromptResult("sess-mt", "GRID_MULTI_8b2c");
      return mcpPromptResult("sess-mt", "done");
    };
    const t = makeMultiTurnTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
    expect((result as { error: string }).error).toContain("was not created");
  });

  test("fails when proof file has wrong content", async () => {
    const cwd = makeTmpDir();
    let callCount = 0;

    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      callCount++;
      if (callCount === 1) return mcpPromptResult("sess-mt", "OK");
      if (callCount === 2) return mcpPromptResult("sess-mt", "GRID_MULTI_8b2c");
      if (callCount === 3) {
        writeFileSync(join(cwd, "multi-turn-proof.txt"), "wrong content");
        return mcpPromptResult("sess-mt", "done");
      }
      return mcpPromptResult("sess-mt", "unexpected");
    };

    const t = makeMultiTurnTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
    expect((result as { error: string }).error).toContain("does not contain");
  });

  test("fails when context not retained in turn 2", async () => {
    const cwd = makeTmpDir();
    let callCount = 0;

    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      callCount++;
      if (callCount === 1) return mcpPromptResult("sess-mt", "OK");
      if (callCount === 2) return mcpPromptResult("sess-mt", "I don't remember");
      return mcpPromptResult("sess-mt", "done");
    };

    const t = makeMultiTurnTest({ callTool });
    const result = await t.run({ provider: requireProvider("claude"), cwd });
    expect(result.status).toBe("fail");
    expect((result as { error: string }).error).toContain("context not retained");
  });

  test("registers onCleanup after turn 1", async () => {
    const cwd = makeTmpDir();
    let cleanupRegistered = false;
    let callCount = 0;

    const callTool: CallToolFn = async (_server, tool) => {
      if (tool.endsWith("_bye")) return mcpTextResult("ok");
      callCount++;
      if (callCount === 1) return mcpPromptResult("sess-mt", "OK");
      if (callCount === 2) return mcpPromptResult("sess-mt", "GRID_MULTI_8b2c");
      if (callCount === 3) {
        writeFileSync(join(cwd, "multi-turn-proof.txt"), "GRID_MULTI_8b2c");
        return mcpPromptResult("sess-mt", "done");
      }
      return mcpPromptResult("sess-mt", "unexpected");
    };

    const t = makeMultiTurnTest({ callTool });
    await t.run({
      provider: requireProvider("claude"),
      cwd,
      onCleanup: () => {
        cleanupRegistered = true;
      },
    });
    expect(cleanupRegistered).toBe(true);
  });
});
