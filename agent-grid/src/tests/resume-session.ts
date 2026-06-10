import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, extractSessionId, extractText, promptAndWait } from "./helpers";

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

      // End the daemon session — bye() deletes the session from the daemon's
      // session map, so we cannot use promptFollowUp with the old sessionId.
      await byeSession(ctx.provider, sessionId, callTool);

      // Resume via --continue: creates a NEW daemon session that restores
      // conversation history from the most recent session in this cwd.
      const resumeRaw = await callTool(ctx.provider.serverName, `${ctx.provider.toolPrefix}_prompt`, {
        prompt: "What was the code I asked you to remember? Reply with just the code, nothing else.",
        resumeSessionId: "continue",
        cwd: ctx.cwd,
        wait: true,
      });

      const resumeText = extractText(resumeRaw);
      if (typeof resumeRaw === "object" && resumeRaw !== null && (resumeRaw as Record<string, unknown>).isError) {
        return { status: "fail", error: `resume prompt failed: ${resumeText.slice(0, 300)}` };
      }

      const resumeSessionId = extractSessionId(resumeText);
      if (resumeSessionId) {
        ctx.onCleanup?.(() => byeSession(ctx.provider, resumeSessionId, callTool));
      }

      try {
        if (!resumeText.includes(MARKER)) {
          return {
            status: "fail",
            error: `context not retained after resume: expected "${MARKER}", got: ${resumeText.slice(0, 200)}`,
          };
        }

        return { status: "pass" };
      } finally {
        if (resumeSessionId) {
          await byeSession(ctx.provider, resumeSessionId, callTool).catch(() => {});
        }
      }
    },
  };
}
