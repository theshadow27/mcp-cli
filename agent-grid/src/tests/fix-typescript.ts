import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GridTest } from "../grid-test";
import { type CallToolFn, byeSession, promptAndWait } from "./helpers";

const FIXTURE = "grid-fix-ts.ts";
const BROKEN_CODE = 'const greeting: number = "hello world";\nconsole.log(greeting);\n';

export function makeFixTypescriptTest(deps: { callTool: CallToolFn }): GridTest {
  return {
    name: "fix-typescript",
    requires: [],
    async run(ctx) {
      const filePath = join(ctx.cwd, FIXTURE);
      writeFileSync(filePath, BROKEN_CODE);

      const result = await promptAndWait(ctx.provider, {
        task: `The file ${FIXTURE} has a TypeScript type error — the type annotation does not match the assigned value. Fix it so the code type-checks. Do not remove or change the console.log line.`,
        cwd: ctx.cwd,
        callTool: deps.callTool,
      });

      ctx.onCleanup?.(() => byeSession(ctx.provider, result.sessionId, deps.callTool));

      try {
        const content = readFileSync(filePath, "utf-8");

        if (/const\s+greeting\s*:\s*number\s*=\s*"/.test(content)) {
          return {
            status: "fail",
            error: `type error not fixed, file still has number annotation with string value: ${content.slice(0, 200)}`,
          };
        }

        if (!content.includes("console.log")) {
          return { status: "fail", error: "console.log line was removed" };
        }

        return { status: "pass" };
      } finally {
        await byeSession(ctx.provider, result.sessionId, deps.callTool).catch(() => {});
      }
    },
  };
}
