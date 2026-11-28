import type { Stage } from "am-i-done";

import { dirScoped } from "./_lib/dir-scoped";
import { DIR_SCOPED_SPEC_DIRS } from "./_lib/test-paths";

export default {
  id: "test-hooks",
  description: "git-hook specs (.git-hooks/*.spec.ts), run from their own directory (#2771)",
  phase: "test",
  modes: ["default", "ci"],
  command: dirScoped(DIR_SCOPED_SPEC_DIRS.hooks, "test_hooks"),
  onFailure: [
    "run `bun run test:hooks` locally to reproduce",
    "specs live in .git-hooks/*.spec.ts, next to classify.sh / sprint-active.sh",
  ],
} satisfies Stage;
