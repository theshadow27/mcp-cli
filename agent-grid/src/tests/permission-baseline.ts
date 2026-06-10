import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, extractText, promptNoWait } from "./helpers";

export function makePermissionBaselineTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "permission-baseline",
    requires: ["permissionRoundtrip"],
    async run(ctx) {
      const { callTool } = deps;

      const { sessionId } = await promptNoWait(ctx.provider, {
        task: "Delete the file named 'nonexistent-sensitive.txt' in the current directory.",
        cwd: ctx.cwd,
        callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, sessionId, callTool));

      try {
        const waitRaw = await callTool(ctx.provider.serverName, `${ctx.provider.toolPrefix}_wait`, {
          sessionId,
          timeout: 30000,
        });
        const waitText = extractText(waitRaw);

        const requestId = extractRequestId(waitText);
        if (!requestId) {
          return {
            status: "fail",
            error: `no permission request received. Wait response: ${waitText.slice(0, 300)}`,
          };
        }

        await callTool(ctx.provider.serverName, `${ctx.provider.toolPrefix}_approve`, {
          sessionId,
          requestId,
        });

        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, sessionId, callTool).catch(() => {});
      }
    },
  };
}

function extractRequestId(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const event = parsed.event ?? parsed;
      if (event.type === "session:permission_request" && typeof event.request?.requestId === "string") {
        return event.request.requestId;
      }
      if (typeof event.requestId === "string") return event.requestId;
    }
  } catch {}
  const match = text.match(/"requestId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "";
}
