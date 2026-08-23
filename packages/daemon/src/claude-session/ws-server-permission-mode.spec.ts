/**
 * `--permission-mode` on the spawn line follows the session's
 * PermissionStrategy (#3119).
 *
 * Before this, `buildSpawnCmd` hardcoded `default` while the router separately
 * decided what to do with the resulting `can_use_tool` requests — and `auto`
 * approved all of them, so a session asking for "auto" got no gate anywhere.
 * These tests pin the flag to the strategy and pin the two cases where `auto`
 * deliberately isn't handed over.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type MonitorEventInput,
  SESSION_PERMISSION_DENIED,
  SESSION_PERMISSION_MODE_DOWNGRADED,
  severityForMonitorEvent,
  silentLogger,
} from "@mcp-cli/core";
import { pollUntil } from "../../../../test/harness";
import { serialize } from "./ndjson";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

/** Claude version known to accept `--permission-mode auto`. */
const MODERN = "2.1.239";
/** Version predating the verified floor — auto mode must not be assumed. */
const ANCIENT = "2.1.100";

const WORKTREE = "/tmp/mcx-permission-mode-worktree";

function mockSpawn(): { spawn: SpawnFn; lastCmd: string[]; pushStdout: (data: string) => void } {
  let exitResolve: (code: number) => void = () => {};
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });

  const state = {
    lastCmd: [] as string[],
    pushStdout: (data: string) => stdoutController?.enqueue(encoder.encode(data)),
    spawn: ((cmd: string[]) => {
      state.lastCmd = cmd;
      return {
        pid: 4242,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        // Teardown must actually finish: stop() waits on the reader draining to
        // EOF and on proc.exited, so kill has to deliver both.
        kill: () => {
          if (stdoutController !== null) {
            const ctrl = stdoutController;
            stdoutController = null;
            ctrl.close();
          }
          exitResolve(143);
        },
        stdout: stdoutStream,
        stdin: { write: () => 0, flush: () => 0 },
        stderrTail: () => "",
      };
    }) as SpawnFn,
  };
  return state;
}

/** The value passed to `--permission-mode`, or undefined if the flag is absent. */
function permissionModeArg(cmd: string[]): string | undefined {
  const idx = cmd.indexOf("--permission-mode");
  return idx === -1 ? undefined : cmd[idx + 1];
}

let server: ClaudeWsServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnWith(opts: {
  claudeVersion: string | null;
  permissionStrategy?: "auto" | "rules" | "delegate";
  worktree?: string;
  cwd?: string;
  onMonitorEvent?: (e: MonitorEventInput) => void;
}): Promise<string[]> {
  const mock = mockSpawn();
  server = new ClaudeWsServer({
    spawn: mock.spawn,
    logger: silentLogger,
    defaultTransport: "stdio",
    claudeVersion: opts.claudeVersion,
  });
  // Attached before prepareSession — that is where the mode is resolved, and
  // therefore where a downgrade is announced.
  if (opts.onMonitorEvent) server.onMonitorEvent = opts.onMonitorEvent;
  await server.start(0);

  const sessionId = crypto.randomUUID();
  server.prepareSession(sessionId, {
    prompt: "test",
    transport: "stdio",
    ...(opts.permissionStrategy && { permissionStrategy: opts.permissionStrategy }),
    ...(opts.worktree && { worktree: opts.worktree }),
    ...(opts.cwd && { cwd: opts.cwd }),
  });
  server.spawnClaude(sessionId);
  return mock.lastCmd;
}

describe("buildSpawnCmd — permission mode follows the strategy", () => {
  test("auto on a modern binary spawns with --permission-mode auto", async () => {
    const cmd = await spawnWith({ claudeVersion: MODERN, permissionStrategy: "auto" });
    expect(permissionModeArg(cmd)).toBe("auto");
  });

  // Both need every tool call to round-trip to the daemon, which is exactly
  // what auto mode removes. Regression guard: their spawn line is unchanged.
  test.each(["rules", "delegate"] as const)("%s still spawns with --permission-mode default", async (strategy) => {
    const cmd = await spawnWith({ claudeVersion: MODERN, permissionStrategy: strategy });
    expect(permissionModeArg(cmd)).toBe("default");
  });

  test("a worktree session keeps default so ContainmentGuard still sees can_use_tool", async () => {
    const cmd = await spawnWith({
      claudeVersion: MODERN,
      permissionStrategy: "auto",
      worktree: "wt",
      cwd: WORKTREE,
    });
    expect(permissionModeArg(cmd)).toBe("default");
    // The bridge that carries that round-trip must still be on the line (#3063).
    expect(cmd).toContain("--permission-prompt-tool");
  });

  test("an unverified binary keeps default rather than risking an argument-parse exit", async () => {
    const cmd = await spawnWith({ claudeVersion: ANCIENT, permissionStrategy: "auto" });
    expect(permissionModeArg(cmd)).toBe("default");
  });

  test("an unknown version keeps default", async () => {
    const cmd = await spawnWith({ claudeVersion: null, permissionStrategy: "auto" });
    expect(permissionModeArg(cmd)).toBe("default");
  });

  // The whole point of #3119 is that a session's permission posture matches the
  // one it asked for. When it can't, that has to be visible, not inferred.
  test("a downgrade emits a monitor event naming the reason", async () => {
    const events: MonitorEventInput[] = [];
    await spawnWith({
      claudeVersion: MODERN,
      permissionStrategy: "auto",
      worktree: "wt",
      cwd: WORKTREE,
      onMonitorEvent: (e) => events.push(e),
    });
    const downgrades = events.filter((e) => e.event === SESSION_PERMISSION_MODE_DOWNGRADED);
    expect(downgrades).toHaveLength(1);
    expect(String(downgrades[0]?.reason)).toContain("ContainmentGuard");
  });

  test("an honoured auto spawn emits no downgrade", async () => {
    const events: MonitorEventInput[] = [];
    await spawnWith({
      claudeVersion: MODERN,
      permissionStrategy: "auto",
      onMonitorEvent: (e) => events.push(e),
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: SESSION_PERMISSION_MODE_DOWNGRADED }));
  });

  // Risk #2 of #3119: a worker that loses a capability to the classifier looks
  // exactly like a worker thinking hard. This is the frame that tells them apart.
  test("a classifier denial from the child surfaces as a monitor event", async () => {
    const mock = mockSpawn();
    const events: MonitorEventInput[] = [];
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      defaultTransport: "stdio",
      claudeVersion: MODERN,
    });
    server.onMonitorEvent = (e) => events.push(e);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "test", transport: "stdio", permissionStrategy: "auto" });
    server.spawnClaude(sessionId);

    // Frame shape captured from claude 2.1.239 under --permission-mode auto.
    mock.pushStdout(
      `${serialize({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "toolu_01ACo74EpdNMJf6Q4yN5bpTK",
        decision_reason_type: "classifier",
        decision_reason: "Blocked by classifier",
        message: "Permission for this action was denied by the Claude Code auto mode classifier.",
        uuid: "uuid-pd",
        session_id: sessionId,
      })}\n`,
    );

    await pollUntil(() => events.some((e) => e.event === SESSION_PERMISSION_DENIED), 1000);
    const denial = events.find((e) => e.event === SESSION_PERMISSION_DENIED);
    expect(denial?.toolName).toBe("Bash");
    expect(denial?.reasonType).toBe("classifier");
    expect(denial?.reason).toBe("Blocked by classifier");
    // `actionable` is what gets it past a monitor filtered to real signals.
    expect(
      severityForMonitorEvent({ ...denial, src: "x", category: "session", event: SESSION_PERMISSION_DENIED }),
    ).toBe("actionable");
  });

  test("no strategy ever produces a permissions-skipping flag", async () => {
    for (const strategy of ["auto", "rules", "delegate"] as const) {
      for (const claudeVersion of [MODERN, ANCIENT, null]) {
        const cmd = await spawnWith({ claudeVersion, permissionStrategy: strategy });
        expect(cmd).not.toContain("--dangerously-skip-permissions");
        expect(permissionModeArg(cmd)).not.toBe("bypassPermissions");
        await server?.stop();
        server = null;
      }
    }
  });
});
