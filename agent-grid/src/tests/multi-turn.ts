import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait, promptFollowUp } from "./helpers";

const MARKER = "GRID_MULTI_8b2c";
const PROOF_FILE = "multi-turn-proof.txt";

export function makeMultiTurnTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "multi-turn",
    requires: ["multiTurn"],
    async run(ctx) {
      const { callTool } = deps;

      const turn1 = await promptAndWait(ctx.provider, {
        task: `Remember this code: ${MARKER}. Reply with "OK" and nothing else.`,
        cwd: ctx.cwd,
        callTool,
      });

      const { sessionId } = turn1;
      if (!sessionId) {
        return { status: "fail", error: "no sessionId returned from turn 1" };
      }

      try {
        const turn2 = await promptFollowUp(ctx.provider, {
          sessionId,
          task: "What was the code I asked you to remember? Reply with just the code, nothing else.",
          cwd: ctx.cwd,
          callTool,
        });

        if (!turn2.text.includes(MARKER)) {
          return {
            status: "fail",
            error: `context not retained: expected "${MARKER}" in turn 2 response, got: ${turn2.text.slice(0, 200)}`,
          };
        }

        await promptFollowUp(ctx.provider, {
          sessionId,
          task: `Write the code ${MARKER} to a file called ${PROOF_FILE} in the current directory.`,
          cwd: ctx.cwd,
          callTool,
        });

        const proofPath = join(ctx.cwd, PROOF_FILE);
        if (!existsSync(proofPath)) {
          return { status: "fail", error: `proof file ${PROOF_FILE} was not created` };
        }

        const content = readFileSync(proofPath, "utf-8");
        if (!content.includes(MARKER)) {
          return {
            status: "fail",
            error: `proof file does not contain "${MARKER}", got: ${content.slice(0, 200)}`,
          };
        }

        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, sessionId, callTool).catch(() => {});
      }
    },
  };
}
