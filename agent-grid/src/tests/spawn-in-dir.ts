import { realpathSync } from "node:fs";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait } from "./helpers";

export function makeSpawnInDirTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "spawn-in-dir",
    requires: [],
    async run(ctx) {
      const resolved = realpathSync(ctx.cwd);
      const result = await promptAndWait(ctx.provider, {
        task: "Print your current working directory path and nothing else. Do not add any explanation.",
        cwd: ctx.cwd,
        callTool: deps.callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, result.sessionId, deps.callTool));

      try {
        if (!result.text.includes(resolved) && !result.text.includes(ctx.cwd)) {
          return { status: "fail", error: `expected cwd "${resolved}" in response, got: ${result.text.slice(0, 200)}` };
        }
        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, result.sessionId, deps.callTool).catch(() => {});
      }
    },
  };
}
