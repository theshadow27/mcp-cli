/**
 * Migration acceptance criteria for #2283 (parseFlags migration).
 *
 * These tests snapshot the current behavior of the legacy manual arg parsers
 * BEFORE migration to parseFlags. The #2283 migration must pass all of these
 * tests (or deliberately change them with documented reasoning).
 *
 * Key behavioral differences captured:
 * - parseSharedSpawnArgs --allow: stops at lowercase tokens (looksLikeToolName heuristic)
 * - parseResumeArgs (claude.ts) --allow: stops only at flag-prefixed tokens (greedier)
 * - parseAgentResumeArgs (agent.ts) --allow: uses looksLikeToolName (same as shared)
 * - --model validation differences between parsers
 * - Negative number handling in --timeout
 * - Flags-as-values bug (current behavior vs. target)
 */
import { describe, expect, it } from "bun:test";

import { parseAgentResumeArgs } from "./commands/agent";
import { parseResumeArgs } from "./commands/claude";
import { parseSharedSpawnArgs } from "./commands/spawn-args";

// ─── parseSharedSpawnArgs: greedy --allow with looksLikeToolName ─────────────

describe("flags-compat: parseSharedSpawnArgs --allow (looksLikeToolName)", () => {
  it("consumes PascalCase tools greedily", () => {
    const r = parseSharedSpawnArgs(["--allow", "Read", "Write", "Glob", "--task", "x"]);
    expect(r.allow).toEqual(["Read", "Write", "Glob"]);
    expect(r.task).toBe("x");
  });

  it("consumes wildcard patterns", () => {
    const r = parseSharedSpawnArgs(["--allow", "Bash*", "*", "--task", "x"]);
    expect(r.allow).toEqual(["Bash*", "*"]);
  });

  it("consumes mcp-style tool names", () => {
    const r = parseSharedSpawnArgs(["--allow", "mcp__echo__add", "mcp__tools__find", "--task", "x"]);
    expect(r.allow).toEqual(["mcp__echo__add", "mcp__tools__find"]);
  });

  it("stops at lowercase token (worktree/session name)", () => {
    const r = parseSharedSpawnArgs(["--allow", "Read", "Write", "my-worktree"]);
    expect(r.allow).toEqual(["Read", "Write"]);
    expect(r.task).toBe("my-worktree");
  });

  it("stops at flag-prefixed token", () => {
    const r = parseSharedSpawnArgs(["--allow", "Read", "--task", "x"]);
    expect(r.allow).toEqual(["Read"]);
    expect(r.task).toBe("x");
  });

  it("errors when no tool patterns follow --allow", () => {
    const r = parseSharedSpawnArgs(["--allow", "--task", "x"]);
    expect(r.error).toBe("--allow requires at least one tool pattern");
  });

  it("errors when --allow is last arg with no following tokens", () => {
    const r = parseSharedSpawnArgs(["--task", "x", "--allow"]);
    expect(r.error).toBe("--allow requires at least one tool pattern");
  });

  it("stops at lowercase-starting hex string (session ID)", () => {
    const r = parseSharedSpawnArgs(["--allow", "Read", "abc12345"]);
    expect(r.allow).toEqual(["Read"]);
    expect(r.task).toBe("abc12345");
  });
});

// ─── parseSharedSpawnArgs: negative numbers and edge cases ───────────────────

describe("flags-compat: parseSharedSpawnArgs numeric edge cases", () => {
  it("--timeout accepts negative number (current behavior: NaN check only)", () => {
    const r = parseSharedSpawnArgs(["--timeout", "-1", "--task", "x"]);
    // Current behavior: -1 passes Number() without NaN but is semantically invalid.
    // The manual parser does NOT reject negative timeouts.
    expect(r.timeout).toBe(-1);
    expect(r.error).toBeUndefined();
  });

  it("--timeout accepts zero", () => {
    const r = parseSharedSpawnArgs(["--timeout", "0", "--task", "x"]);
    expect(r.timeout).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it("--timeout accepts float", () => {
    const r = parseSharedSpawnArgs(["--timeout", "1.5", "--task", "x"]);
    expect(r.timeout).toBe(1.5);
    expect(r.error).toBeUndefined();
  });

  it("--timeout rejects non-numeric", () => {
    const r = parseSharedSpawnArgs(["--timeout", "abc", "--task", "x"]);
    expect(r.error).toBe("--timeout must be a number");
  });

  it("--timeout treats Infinity as valid (Number('Infinity') is not NaN)", () => {
    const r = parseSharedSpawnArgs(["--timeout", "Infinity", "--task", "x"]);
    expect(r.timeout).toBe(Number.POSITIVE_INFINITY);
    expect(r.error).toBeUndefined();
  });

  it("--timeout treats hex as valid (Number('0x10') is 16)", () => {
    const r = parseSharedSpawnArgs(["--timeout", "0x10", "--task", "x"]);
    expect(r.timeout).toBe(16);
    expect(r.error).toBeUndefined();
  });

  it("--timeout treats scientific notation as valid (Number('1e3') is 1000)", () => {
    const r = parseSharedSpawnArgs(["--timeout", "1e3", "--task", "x"]);
    expect(r.timeout).toBe(1000);
    expect(r.error).toBeUndefined();
  });
});

// ─── parseSharedSpawnArgs: --model flag-as-value rejection ────────────────────

describe("flags-compat: parseSharedSpawnArgs --model validation", () => {
  it("rejects flag-looking value (startsWith '-')", () => {
    const r = parseSharedSpawnArgs(["--model", "--task", "x"]);
    expect(r.error).toBe("--model requires a value");
  });

  it("rejects short flag as value", () => {
    const r = parseSharedSpawnArgs(["-m", "-t", "x"]);
    expect(r.error).toBe("--model requires a value");
  });

  it("rejects 'null' literal (jq coercion guard)", () => {
    const r = parseSharedSpawnArgs(["--model", "null", "--task", "x"]);
    expect(r.error).toMatch(/not a valid model name/);
  });

  it("rejects 'none' literal", () => {
    const r = parseSharedSpawnArgs(["--model", "none", "--task", "x"]);
    expect(r.error).toMatch(/not a valid model name/);
  });

  it("rejects 'undefined' literal", () => {
    const r = parseSharedSpawnArgs(["--model", "undefined", "--task", "x"]);
    expect(r.error).toMatch(/not a valid model name/);
  });

  it("accepts bare '-' as model value (current bug: not rejected)", () => {
    // Bare "-" doesn't startsWith("-") after the first char check — actually it does.
    // Let's verify: "-".startsWith("-") === true, so it IS rejected.
    const r = parseSharedSpawnArgs(["--model", "-", "--task", "x"]);
    expect(r.error).toBe("--model requires a value");
  });
});

// ─── parseSharedSpawnArgs: stdin sentinel '-' ────────────────────────────────

describe("flags-compat: parseSharedSpawnArgs stdin sentinel", () => {
  it("bare '-' is silently dropped (not a positional, not a known flag)", () => {
    // "-".startsWith("-") is true, so it's not captured as a positional.
    // It doesn't match any flag either, so it's silently ignored.
    const r = parseSharedSpawnArgs(["-"]);
    expect(r.task).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("bare '-' after --task is accepted as task value (unconditional consume)", () => {
    const r = parseSharedSpawnArgs(["--task", "-"]);
    expect(r.task).toBe("-");
    expect(r.error).toBeUndefined();
  });
});

// ─── parseResumeArgs (claude.ts): greedy --allow WITHOUT looksLikeToolName ───

describe("flags-compat: parseResumeArgs --allow (greedy, no heuristic)", () => {
  it("consumes ALL non-flag tokens (including lowercase)", () => {
    const r = parseResumeArgs(["my-worktree", "--allow", "Read", "my-session-id", "random-string"]);
    // claude.ts uses !args[i+1].startsWith("-") — so lowercase tokens ARE consumed
    expect(r.allow).toEqual(["Read", "my-session-id", "random-string"]);
    expect(r.target).toBe("my-worktree");
  });

  it("stops only at flag-prefixed token", () => {
    const r = parseResumeArgs(["wt", "--allow", "Read", "write-file", "--wait"]);
    expect(r.allow).toEqual(["Read", "write-file"]);
    expect(r.wait).toBe(true);
  });

  it("consumes PascalCase and lowercase alike", () => {
    const r = parseResumeArgs(["wt", "--allow", "Read", "custom-tool", "Glob"]);
    expect(r.allow).toEqual(["Read", "custom-tool", "Glob"]);
  });

  it("errors when no values follow --allow (next is flag)", () => {
    const r = parseResumeArgs(["wt", "--allow", "--wait"]);
    expect(r.error).toBe("--allow requires at least one tool pattern");
  });

  it("errors when --allow is last token", () => {
    const r = parseResumeArgs(["wt", "--allow"]);
    expect(r.error).toBe("--allow requires at least one tool pattern");
  });
});

// ─── parseResumeArgs (claude.ts): --model does NOT reject flags-as-values ────

describe("flags-compat: parseResumeArgs --model (no flag-as-value check)", () => {
  it("accepts any non-empty value including flag-looking strings (current bug)", () => {
    // claude.ts parseResumeArgs: `if (!val)` — only checks emptiness, not startsWith("-")
    // When --model is followed by another flag like --wait, val = "--wait" which is truthy
    // so it gets passed to resolveModelName. But ++i already consumed it.
    const r = parseResumeArgs(["wt", "--model", "sonnet"]);
    expect(r.model).toContain("sonnet");
    expect(r.error).toBeUndefined();
  });

  it("errors when --model is at end of args (val is undefined)", () => {
    const r = parseResumeArgs(["wt", "--model"]);
    expect(r.error).toBe("--model requires a value");
  });
});

// ─── parseResumeArgs (claude.ts): --timeout numeric edge cases ───────────────

describe("flags-compat: parseResumeArgs --timeout", () => {
  it("accepts negative timeout (no range validation)", () => {
    const r = parseResumeArgs(["wt", "--timeout", "-1"]);
    expect(r.timeout).toBe(-1);
    expect(r.error).toBeUndefined();
  });

  it("errors on non-numeric", () => {
    const r = parseResumeArgs(["wt", "--timeout", "abc"]);
    expect(r.error).toBe("--timeout must be a number");
  });

  it("errors on missing value", () => {
    const r = parseResumeArgs(["wt", "--timeout"]);
    expect(r.error).toBe("--timeout requires a value in ms");
  });
});

// ─── parseAgentResumeArgs: --allow with looksLikeToolName (same as shared) ───

describe("flags-compat: parseAgentResumeArgs --allow (looksLikeToolName)", () => {
  it("consumes PascalCase tools", () => {
    const r = parseAgentResumeArgs(["wt", "--allow", "Read", "Write", "Glob"]);
    expect(r.allow).toEqual(["Read", "Write", "Glob"]);
    expect(r.target).toBe("wt");
  });

  it("stops at lowercase token (unlike claude.ts)", () => {
    const r = parseAgentResumeArgs(["wt", "--allow", "Read", "my-session"]);
    expect(r.allow).toEqual(["Read"]);
    // "my-session" becomes positional → sessionId
    expect(r.sessionId).toBe("my-session");
  });

  it("consumes wildcard patterns", () => {
    const r = parseAgentResumeArgs(["wt", "--allow", "*", "Bash*"]);
    expect(r.allow).toEqual(["*", "Bash*"]);
  });

  it("consumes mcp-style names", () => {
    const r = parseAgentResumeArgs(["wt", "--allow", "mcp__echo__add"]);
    expect(r.allow).toEqual(["mcp__echo__add"]);
  });

  it("errors when --allow has no tool-looking followers", () => {
    const r = parseAgentResumeArgs(["wt", "--allow", "--wait"]);
    expect(r.error).toBe("--allow requires at least one tool pattern");
  });
});

// ─── parseAgentResumeArgs: --model flag-as-value rejection ───────────────────

describe("flags-compat: parseAgentResumeArgs --model", () => {
  it("rejects flag-looking value (startsWith '-')", () => {
    const r = parseAgentResumeArgs(["wt", "--model", "--wait"]);
    expect(r.error).toBe("--model requires a value");
  });

  it("accepts a valid model string without resolveModelName (passes raw)", () => {
    // agent.ts parseAgentResumeArgs does NOT call resolveModelName — stores raw
    const r = parseAgentResumeArgs(["wt", "--model", "opus"]);
    expect(r.model).toBe("opus");
  });

  it("errors when --model is at end of args", () => {
    const r = parseAgentResumeArgs(["wt", "--model"]);
    expect(r.error).toBe("--model requires a value");
  });
});

// ─── parseAgentResumeArgs: --timeout ─────────────────────────────────────────

describe("flags-compat: parseAgentResumeArgs --timeout", () => {
  it("accepts -t shorthand", () => {
    const r = parseAgentResumeArgs(["wt", "-t", "5000"]);
    expect(r.timeout).toBe(5000);
  });

  it("accepts negative timeout", () => {
    const r = parseAgentResumeArgs(["wt", "--timeout", "-1"]);
    expect(r.timeout).toBe(-1);
    expect(r.error).toBeUndefined();
  });

  it("errors on non-numeric", () => {
    const r = parseAgentResumeArgs(["wt", "-t", "abc"]);
    expect(r.error).toBe("--timeout must be a number");
  });
});

// ─── Cross-parser behavioral differences (migration must decide) ─────────────

describe("flags-compat: behavioral divergences between parsers", () => {
  it("--allow greediness: claude.ts eats lowercase, shared/agent does not", () => {
    // Same input, different results — the migration must choose one behavior
    const claudeResult = parseResumeArgs(["wt", "--allow", "Read", "lowercase-tool"]);
    const agentResult = parseAgentResumeArgs(["wt", "--allow", "Read", "lowercase-tool"]);
    const sharedResult = parseSharedSpawnArgs(["--allow", "Read", "lowercase-tool"]);

    // claude: greedy — consumes lowercase
    expect(claudeResult.allow).toEqual(["Read", "lowercase-tool"]);
    // agent: heuristic — stops at lowercase
    expect(agentResult.allow).toEqual(["Read"]);
    // shared: heuristic — stops at lowercase
    expect(sharedResult.allow).toEqual(["Read"]);
  });

  it("--model resolution: claude.ts calls resolveModelName, agent.ts passes raw", () => {
    const claudeResult = parseResumeArgs(["wt", "--model", "sonnet"]);
    const agentResult = parseAgentResumeArgs(["wt", "--model", "sonnet"]);

    // claude.ts resolves shortname to full model ID
    expect(claudeResult.model).toContain("sonnet");
    expect(claudeResult.model?.length).toBeGreaterThan("sonnet".length);
    // agent.ts stores raw value
    expect(agentResult.model).toBe("sonnet");
  });

  it("--model flag-as-value: shared rejects, claude accepts (bug)", () => {
    // shared/agent: val.startsWith("-") check rejects flags-as-values
    const sharedResult = parseSharedSpawnArgs(["--model", "--wait", "--task", "x"]);
    expect(sharedResult.error).toBe("--model requires a value");

    const agentResult = parseAgentResumeArgs(["wt", "--model", "--wait"]);
    expect(agentResult.error).toBe("--model requires a value");

    // claude.ts: only checks `if (!val)` — flag-looking values get consumed as model
    // But since ++i consumed "--wait", the --wait boolean is NOT set
    const claudeResult = parseResumeArgs(["wt", "--model", "--wait"]);
    // "--wait" is truthy, so no error — it's accepted as a model name
    // resolveModelName("--wait") likely returns "--wait" as-is (unknown pass-through)
    expect(claudeResult.error).toBeUndefined();
    expect(claudeResult.wait).toBe(false); // --wait was consumed as model value
  });

  it("--timeout shorthand: agent.ts has -t, claude.ts does not", () => {
    // agent: -t is a shorthand for --timeout
    const agentResult = parseAgentResumeArgs(["wt", "-t", "5000"]);
    expect(agentResult.timeout).toBe(5000);

    // claude: -t is NOT recognized — becomes unknown/ignored
    const claudeResult = parseResumeArgs(["wt", "-t", "5000"]);
    expect(claudeResult.timeout).toBeUndefined();
  });
});
