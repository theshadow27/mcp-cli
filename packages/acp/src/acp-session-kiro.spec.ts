import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@mcp-cli/core";
import { AcpSession } from "./acp-session";

// Kiro host-auth callback (`_kiro/auth/getAccessToken`) tests.
//
// Real kiro-cli's KAS launches with `--auth=acp-callback`: it asks the ACP client
// for an access token via a server→client request during the handshake, and fails
// `session/prompt` with ModelRegistryUnauthenticatedError if none is supplied.
// The `kiro-auth-callback` fake mode reproduces exactly that. These guard the bug
// where the client answered the callback with `{}` and every kiro turn died at
// prompt time — a failure the happy-path fixtures could never surface.
//
// Split into its own file (from acp-session.spec.ts) so the kiro-auth-callback
// poll wait doesn't push the main session spec over the 5s per-file budget.

const FAKE_AGENT = join(import.meta.dirname, "fake-acp-agent.ts");
const TEST_CWD = process.cwd();
const KIRO_CMD = ["bun", FAKE_AGENT, "kiro-auth-callback"];

function makeSession(overrides: Partial<ConstructorParameters<typeof AcpSession>[1]> = {}): {
  session: AcpSession;
  events: AgentSessionEvent[];
} {
  const events: AgentSessionEvent[] = [];
  const session = new AcpSession("test-session", { cwd: TEST_CWD, prompt: "hello", agent: "kiro", ...overrides }, (e) =>
    events.push(e),
  );
  return { session, events };
}

describe("AcpSession (kiro host-auth callback)", () => {
  test("turn completes when KIRO_API_KEY is set (token handed to the auth callback)", async () => {
    const { session } = makeSession({ customCommand: KIRO_CMD, env: { KIRO_API_KEY: "test-access-token" } });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    expect(session.currentState).toBe("idle");
  });

  test("turn completes via the local-store token path (injected resolver, no KIRO_API_KEY)", async () => {
    // Exercises tier 2 of handleKiroAuthTokenRequest — the Keychain/SQLite store
    // fallback — without touching real credentials. The injected resolver stands in
    // for resolveKiroToken; disabling the real lookup proves the callback used it.
    let resolverCalls = 0;
    const { session } = makeSession({
      customCommand: KIRO_CMD,
      env: { KIRO_API_KEY: "", MCX_KIRO_DISABLE_TOKEN_LOOKUP: "1" },
      resolveToken: () => {
        resolverCalls++;
        return {
          accessToken: "store-token",
          expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
          profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/ABC",
        };
      },
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    expect(resolverCalls).toBeGreaterThan(0);
  });

  test("turn fails with an actionable error when no token is available", async () => {
    // No KIRO_API_KEY and the local-store lookup disabled → resolveKiroToken finds
    // nothing, so the callback is answered empty and KAS (the fake) rejects the prompt.
    const { session } = makeSession({
      customCommand: KIRO_CMD,
      env: { KIRO_API_KEY: "", MCX_KIRO_DISABLE_TOKEN_LOOKUP: "1" },
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:error");
    if (result.type === "session:error") {
      // The raw KAS message plus mcx's actionable hint pointing at kiro-cli login / KIRO_API_KEY.
      expect(result.errors[0]).toContain("not signed in");
      expect(result.errors[0]).toMatch(/kiro-cli login|KIRO_API_KEY/);
    }
  });

  test("a non-kiro agent that emits the kiro auth callback gets nothing (credential gate)", async () => {
    // Security regression (reviewer BLOCKER 1): a session declared as a NON-kiro
    // agent must never receive a Kiro token, even if it speaks the kiro auth method.
    // The fake in kiro-auth-callback mode fails its prompt when handed no token, so
    // a session:error here proves the gate withheld the credential.
    const { session } = makeSession({
      agent: "grok", // NOT kiro
      customCommand: KIRO_CMD,
      env: { KIRO_API_KEY: "SUPER-SECRET-KIRO-TOKEN" },
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    // The gate returned {} to the callback, so the fake KAS rejects the prompt.
    expect(result.type).toBe("session:error");
  });

  test("an early server-request (pre-initialize) is handled, not dropped", async () => {
    // `auth-before-init` emits _kiro/auth/getAccessToken on its first output, before
    // the client sends initialize. This is a behavioral guard for the RPC-before-spawn
    // ordering invariant: an early server-request must reach handleServerRequest and be
    // answered so the turn completes. (Under today's AcpProcess the first read suspends
    // synchronously so `this.rpc` is always assigned first — this asserts the invariant
    // holds regardless, not that a live race exists.)
    const { session } = makeSession({ customCommand: ["bun", FAKE_AGENT, "auth-before-init"] });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
  });

  test("terminal/create with a command and no args runs through a shell (kiro shape)", async () => {
    // Kiro sends `command: "echo hi && ls"` with no `args`; copilot/gemini send the
    // exec form (`command:"git"`, `args:["status"]`). Without the sh -c fallback the
    // whole string is exec'd as argv[0] and every kiro run_command silently fails.
    const dir = mkdtempSync(join(tmpdir(), "acp-shell-"));
    const probe = join(dir, "probe.txt");
    try {
      const { session } = makeSession({
        customCommand: ["bun", FAKE_AGENT, "terminal-shell"],
        env: { ACP_FAKE_SHELL_PROBE: probe, MCX_KIRO_DISABLE_TOKEN_LOOKUP: "1" },
      });

      const resultPromise = session.waitForResult(10000);
      await session.start();
      await resultPromise;

      // The shell operators only take effect if the command ran under `sh -c`.
      expect(existsSync(probe)).toBe(true);
      expect(readFileSync(probe, "utf8").trim()).toBe("shell-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
