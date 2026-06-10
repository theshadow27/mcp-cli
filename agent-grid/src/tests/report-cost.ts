import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, extractText, promptAndWait } from "./helpers";

export function makeReportCostTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "report-cost",
    requires: ["costTracking"],
    async run(ctx) {
      const { callTool } = deps;

      const result = await promptAndWait(ctx.provider, {
        task: 'Reply with "hello" and nothing else.',
        cwd: ctx.cwd,
        callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, result.sessionId, callTool));

      try {
        const costFromResult = findCost(result.text);
        if (costFromResult > 0) return { status: "pass" };

        const listRaw = await callTool(ctx.provider.serverName, `${ctx.provider.toolPrefix}_session_list`, {});
        const listText = extractText(listRaw);
        const listCost = findCostForSession(listText, result.sessionId);
        if (listCost > 0) return { status: "pass" };

        return {
          status: "fail",
          error: `no cost > 0 reported. Result: ${result.text.slice(0, 300)}`,
        };
      } finally {
        await byeSession(ctx.provider, result.sessionId, callTool).catch(() => {});
      }
    },
  };
}

function findCost(text: string): number {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.cost === "number") return parsed.cost;
      if (typeof parsed.result?.cost === "number") return parsed.result.cost;
    }
  } catch {}
  const match = text.match(/"cost"\s*:\s*([\d.]+)/);
  return match ? Number.parseFloat(match[1]) : 0;
}

function findCostForSession(listText: string, sessionId: string): number {
  try {
    const list = JSON.parse(listText);
    if (Array.isArray(list)) {
      const entry = list.find((e: Record<string, unknown>) => e.sessionId === sessionId);
      if (entry && typeof entry.cost === "number") return entry.cost;
    }
  } catch {}
  return 0;
}
