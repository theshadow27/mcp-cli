import type { Stage } from "am-i-done";

import { dirScoped } from "./_lib/dir-scoped";
import { DIR_SCOPED_SPEC_DIRS } from "./_lib/test-paths";

export default {
  id: "test-phases",
  description: "phase fn-specs (.claude/phases/*-fn.spec.ts), run from their own directory (#2648)",
  phase: "test",
  modes: ["default", "ci"],
  command: dirScoped(DIR_SCOPED_SPEC_DIRS.phases, "test_phases"),
  onFailure: [
    "run `bun run test:phases` locally to reproduce",
    "specs live in .claude/phases/*-fn.spec.ts, next to each phase module",
  ],
} satisfies Stage;
