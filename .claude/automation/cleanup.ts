import { defineAutomation } from "@mcp-cli/core";

const SESSION_KEY_PATTERN = /session_id$/;

export default defineAutomation({
  name: "cleanup",
  events: ["pr.merged"],
  fn: async (event, ctx) => {
    const mergeSha = event.mergeSha;
    if (typeof mergeSha !== "string" || !mergeSha) {
      return { action: "none", reason: "pr.merged event missing mergeSha — cannot verify merge" };
    }

    const prNumber = event.prNumber;
    if (typeof prNumber !== "number") {
      return { action: "none", reason: "pr.merged event missing prNumber" };
    }

    const state = await ctx.state.all();
    const sessionIds: string[] = [];
    for (const [key, value] of Object.entries(state)) {
      if (SESSION_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 0) {
        if (!value.startsWith("pending:")) {
          sessionIds.push(value);
        }
      }
    }

    if (sessionIds.length === 0) {
      ctx.logger.info(`PR #${prNumber} merged (${mergeSha.slice(0, 8)}) but no sessions to clean up`);
      return { action: "none", reason: `merged but no session IDs in state` };
    }

    ctx.logger.info(
      `PR #${prNumber} verified merged at ${mergeSha.slice(0, 8)} — cleaning up ${sessionIds.length} session(s)`,
    );
    return {
      action: "bye-and-untrack",
      sessionIds,
    };
  },
});
