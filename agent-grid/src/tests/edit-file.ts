import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait } from "./helpers";

const FIXTURE = "grid-test-edit.txt";
const ORIGINAL = "GRID_EDIT_ORIGINAL_4d9e";
const MODIFIED = "GRID_EDIT_MODIFIED_4d9e";

export function makeEditFileTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "edit-file",
    requires: [],
    async run(ctx) {
      const filePath = join(ctx.cwd, FIXTURE);
      writeFileSync(filePath, `line1\n${ORIGINAL}\nline3\n`);

      const result = await promptAndWait(ctx.provider, {
        task: `Edit the file ${FIXTURE} in your current directory: replace the text "${ORIGINAL}" with "${MODIFIED}". Do not change anything else. Do not explain.`,
        cwd: ctx.cwd,
        callTool: deps.callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, result.sessionId, deps.callTool));

      try {
        const content = readFileSync(filePath, "utf-8");
        if (!content.includes(MODIFIED)) {
          return {
            status: "fail",
            error: `file does not contain "${MODIFIED}" after edit. Content: ${content.slice(0, 200)}`,
          };
        }
        if (content.includes(ORIGINAL)) {
          return { status: "fail", error: `file still contains "${ORIGINAL}" — replacement incomplete` };
        }
        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, result.sessionId, deps.callTool).catch(() => {});
      }
    },
  };
}
