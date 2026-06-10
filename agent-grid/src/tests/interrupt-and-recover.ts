import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait, promptNoWait } from "./helpers";

const MARKER = "GRID_INTERRUPT_RECOVER_5e7a";
const PROOF_FILE = "grid-interrupt-proof.txt";

export function makeInterruptAndRecoverTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "interrupt-and-recover",
    requires: ["interruptAck"],
    async run(ctx) {
      const { callTool } = deps;

      const { sessionId } = await promptNoWait(ctx.provider, {
        task: "Count slowly from 1 to 1000000, printing each number on its own line.",
        cwd: ctx.cwd,
        callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, sessionId, callTool));

      try {
        await callTool(ctx.provider.serverName, `${ctx.provider.toolPrefix}_interrupt`, {
          sessionId,
        });

        const recovery = await promptAndWait(ctx.provider, {
          task: `Write the exact text "${MARKER}" to a file called ${PROOF_FILE} in your current directory. Nothing else.`,
          cwd: ctx.cwd,
          callTool,
        });

        ctx.onCleanup?.(() => byeSession(ctx.provider, recovery.sessionId, callTool));

        const proofPath = join(ctx.cwd, PROOF_FILE);
        if (!existsSync(proofPath)) {
          return { status: "fail", error: `proof file ${PROOF_FILE} not created after interrupt recovery` };
        }

        const content = readFileSync(proofPath, "utf-8");
        if (!content.includes(MARKER)) {
          return {
            status: "fail",
            error: `proof file missing marker "${MARKER}", got: ${content.slice(0, 200)}`,
          };
        }

        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, sessionId, callTool).catch(() => {});
      }
    },
  };
}
