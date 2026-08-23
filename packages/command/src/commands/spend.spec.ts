import { describe, expect, test } from "bun:test";
import type { DomainSpendResult, IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import type { SpendDeps } from "./spend";
import { cmdSpend } from "./spend";

function toolResult(
  json: unknown,
  isError = false,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(json) }], ...(isError ? { isError: true } : {}) };
}

function makeDeps(
  overrides: {
    callTool?: (params: unknown) => unknown;
    now?: () => number;
  } = {},
): SpendDeps {
  return {
    ipcCall: async <M extends IpcMethod>(method: M, params?: unknown): Promise<IpcMethodResult[M]> => {
      if (method !== "callTool") throw new Error(`Unexpected IPC call: ${method}`);
      if (!overrides.callTool) throw new Error("callTool not stubbed");
      return overrides.callTool(params) as IpcMethodResult[M];
    },
    now: overrides.now ?? (() => 1_800_000_000_000),
  };
}

async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWrite = process.stderr.write.bind(process.stderr);

  console.log = (...args: unknown[]) => stdoutChunks.push(args.join(" "));
  console.error = (...args: unknown[]) => stderrChunks.push(args.join(" "));
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  const savedExitCode = process.exitCode;
  process.exitCode = 0;
  let capturedExitCode = 0;

  try {
    await fn();
  } finally {
    capturedExitCode = (process.exitCode as number) ?? 0;
    console.log = origLog;
    console.error = origError;
    process.stderr.write = origWrite;
    process.exitCode = savedExitCode;
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: capturedExitCode };
}

const RESULT_TWO_DOMAINS: DomainSpendResult = {
  query: { domain: null, sinceMs: null },
  totals: [
    { domain: "clrg", source: "daemon", totalCost: 2, totalTokens: 2000, sessionCount: 1 },
    { domain: "phoenix", source: "daemon", totalCost: 2, totalTokens: 1500, sessionCount: 2 },
  ],
  sessions: [
    {
      domain: "phoenix",
      domainId: 1,
      source: "daemon",
      sessionId: "p1",
      model: "opus",
      cost: 1.5,
      tokens: 1000,
      spawnedAtMs: 1_700_000_000_000,
    },
    {
      domain: "phoenix",
      domainId: 1,
      source: "daemon",
      sessionId: "p2",
      model: "sonnet",
      cost: 0.5,
      tokens: 500,
      spawnedAtMs: 1_700_000_100_000,
    },
    {
      domain: "clrg",
      domainId: 2,
      source: "daemon",
      sessionId: "c1",
      model: "opus",
      cost: 2,
      tokens: 2000,
      spawnedAtMs: 1_700_000_200_000,
    },
  ],
  unknownDomain: false,
};

describe("cmdSpend", () => {
  test("--json prints the raw result verbatim", async () => {
    const deps = makeDeps({ callTool: () => toolResult(RESULT_TWO_DOMAINS) });
    const { stdout, exitCode } = await captureOutput(() => cmdSpend(["--json"], deps));
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(RESULT_TWO_DOMAINS);
  });

  test("human table lists every domain's totals with its source", async () => {
    const deps = makeDeps({ callTool: () => toolResult(RESULT_TWO_DOMAINS) });
    const { stdout, exitCode } = await captureOutput(() => cmdSpend([], deps));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phoenix");
    expect(stdout).toContain("clrg");
    expect(stdout).toContain("daemon");
    expect(stdout).toContain("$2.0000");
    expect(stdout).toContain("Total: $4.0000 across 2 domain(s), 3 session(s)");
  });

  test("-d filters to one domain and passes it through to the tool call", async () => {
    let captured: unknown;
    const filtered: DomainSpendResult = {
      query: { domain: "phoenix", sinceMs: null },
      totals: [RESULT_TWO_DOMAINS.totals[1]],
      sessions: RESULT_TWO_DOMAINS.sessions.filter((s) => s.domain === "phoenix"),
      unknownDomain: false,
    };
    const deps = makeDeps({
      callTool: (params) => {
        captured = params;
        return toolResult(filtered);
      },
    });

    const { stdout, exitCode } = await captureOutput(() => cmdSpend(["-d", "phoenix"], deps));
    expect(exitCode).toBe(0);
    expect(captured).toMatchObject({ tool: "get_domain_spend", arguments: { domain: "phoenix" } });
    expect(stdout).toContain("phoenix");
    expect(stdout).not.toContain("clrg");
    // per-session breakdown shown when filtering to one domain
    expect(stdout).toContain("p1");
    expect(stdout).toContain("p2");
    expect(stdout).toContain("Sessions:");
  });

  test("--since converts a duration to a sinceMs cutoff on the tool call", async () => {
    let captured: unknown;
    const deps = makeDeps({
      now: () => 1_000_000_000_000,
      callTool: (params) => {
        captured = params;
        return toolResult(RESULT_TWO_DOMAINS);
      },
    });

    await cmdSpend(["--since", "1d"], deps);
    expect(captured).toMatchObject({ arguments: { sinceMs: 1_000_000_000_000 - 86_400_000 } });
  });

  test("rejects an invalid --since duration", async () => {
    const deps = makeDeps({ callTool: () => toolResult(RESULT_TWO_DOMAINS) });
    const { stderr, exitCode } = await captureOutput(() => cmdSpend(["--since", "nonsense"], deps));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid duration");
  });

  test("unknown domain exits 1 with a clear message, not an empty table", async () => {
    const deps = makeDeps({
      callTool: () =>
        toolResult({ query: { domain: "ghost", sinceMs: null }, totals: [], sessions: [], unknownDomain: true }),
    });
    const { stderr, exitCode } = await captureOutput(() => cmdSpend(["-d", "ghost"], deps));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ghost");
  });

  test("empty totals (no spend recorded) is not treated as an error", async () => {
    const deps = makeDeps({
      callTool: () =>
        toolResult({ query: { domain: null, sinceMs: null }, totals: [], sessions: [], unknownDomain: false }),
    });
    const { stderr, exitCode } = await captureOutput(() => cmdSpend([], deps));
    expect(exitCode).toBe(0);
    expect(stderr).toContain("no spend recorded");
  });

  test("daemon tool error surfaces the error text and exits 1", async () => {
    const deps = makeDeps({ callTool: () => toolResult("boom", true) });
    const { stderr, exitCode } = await captureOutput(() => cmdSpend([], deps));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("boom");
  });

  test("ipcCall rejection (daemon unreachable) surfaces the error and exits 1", async () => {
    const deps: SpendDeps = {
      ipcCall: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      now: () => Date.now(),
    };
    const { stderr, exitCode } = await captureOutput(() => cmdSpend([], deps));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ECONNREFUSED");
  });

  test("--help shows usage and does not call the daemon", async () => {
    const deps = makeDeps({
      callTool: () => {
        throw new Error("should not be called");
      },
    });
    const { stdout, exitCode } = await captureOutput(() => cmdSpend(["--help"], deps));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mcx spend");
  });

  test("unknown flag exits 1", async () => {
    const deps = makeDeps({ callTool: () => toolResult(RESULT_TWO_DOMAINS) });
    const { exitCode } = await captureOutput(() => cmdSpend(["--bogus"], deps));
    expect(exitCode).toBe(1);
  });
});
