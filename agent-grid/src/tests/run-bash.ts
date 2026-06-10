import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait } from "./helpers";

const MARKER = "GRID_BASH_PROOF_9c4f";
const PROOF_FILE = "grid-bash-proof.txt";

export function makeRunBashTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "run-bash",
    requires: [],
    async run(ctx) {
      const result = await promptAndWait(ctx.provider, {
        task: `Run this exact bash command: echo '${MARKER}' > ${PROOF_FILE}\nDo not explain, just run it.`,
        cwd: ctx.cwd,
        callTool: deps.callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, result.sessionId, deps.callTool));

      try {
        const proofPath = join(ctx.cwd, PROOF_FILE);
        if (!existsSync(proofPath)) {
          return { status: "fail", error: `proof file ${PROOF_FILE} was not created by bash` };
        }
        const content = readFileSync(proofPath, "utf-8");
        if (!content.includes(MARKER)) {
          return { status: "fail", error: `proof file missing marker "${MARKER}", got: ${content.slice(0, 200)}` };
        }
        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, result.sessionId, deps.callTool).catch(() => {});
      }
    },
  };
}
