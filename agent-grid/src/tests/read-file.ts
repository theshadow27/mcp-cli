import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait } from "./helpers";

const MARKER = "GRID_READ_MARKER_7f3a";
const FIXTURE = "grid-test-read.txt";

export function makeReadFileTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "read-file",
    requires: [],
    async run(ctx) {
      writeFileSync(join(ctx.cwd, FIXTURE), MARKER);

      const result = await promptAndWait(ctx.provider, {
        task: `Read the file ${FIXTURE} in your current directory and reply with its exact contents. Nothing else.`,
        cwd: ctx.cwd,
        callTool: deps.callTool,
      });

      try {
        if (!result.text.includes(MARKER)) {
          return {
            status: "fail",
            error: `expected marker "${MARKER}" in response, got: ${result.text.slice(0, 200)}`,
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
