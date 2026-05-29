import { realpathSync } from "node:fs";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait } from "./helpers";

export function makeRunBashTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "run-bash",
    requires: [],
    async run(ctx) {
      const expected = realpathSync(ctx.cwd);
      const result = await promptAndWait(ctx.provider, {
        task: "Run the bash command `pwd` and reply with the output. Nothing else.",
        cwd: ctx.cwd,
        callTool: deps.callTool,
      });

      try {
        if (!result.text.includes(expected)) {
          return {
            status: "fail",
            error: `expected pwd output "${expected}" in response, got: ${result.text.slice(0, 200)}`,
          };
        }
        return { status: "pass" };
      } finally {
        if (result.sessionId) {
          await byeSession(ctx.provider, result.sessionId, deps.callTool).catch(() => {});
        }
      }
    },
  };
}
