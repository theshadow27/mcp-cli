import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait, promptFollowUp } from "./helpers";

const MARKER = "GRID_RESUME_a3f9";

export function makeResumeSessionTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "resume-session",
    requires: ["resume"],
    async run(ctx) {
      const { callTool } = deps;

      const turn1 = await promptAndWait(ctx.provider, {
        task: `Remember this code: ${MARKER}. Reply with "OK" and nothing else.`,
        cwd: ctx.cwd,
        callTool,
      });

      const { sessionId } = turn1;

      await byeSession(ctx.provider, sessionId, callTool);

      try {
        const resumed = await promptFollowUp(ctx.provider, {
          sessionId,
          task: "What was the code I asked you to remember? Reply with just the code, nothing else.",
          cwd: ctx.cwd,
          callTool,
        });

        ctx.onCleanup?.(() => byeSession(ctx.provider, sessionId, callTool));

        if (!resumed.text.includes(MARKER)) {
          return {
            status: "fail",
            error: `context not retained after resume: expected "${MARKER}", got: ${resumed.text.slice(0, 200)}`,
          };
        }

        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, sessionId, callTool).catch(() => {});
      }
    },
  };
}
