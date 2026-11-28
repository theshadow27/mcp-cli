import type { Stage } from "am-i-done";

import { ciPartition } from "./_lib/partition";
import { NON_DAEMON_TEST_PATHS } from "./_lib/test-paths";

/** CI's first partition: sequential, no --parallel, with the #1004 crash tolerance. */
export default {
  id: "test-non-daemon",
  description: "non-daemon tests (sequential; #1004 crash-after-pass + panic-retry tolerance)",
  phase: "test",
  modes: ["ci"],
  cores: "max",
  command: ciPartition(NON_DAEMON_TEST_PATHS, "test_non_daemon"),
  onFailure: [
    "real failure: see the captured output above",
    "post-test Bun crash (#1004): a summary showing `0 fail` would have been treated as a pass",
    "log artefact: build/test-logs/test_non_daemon.txt",
  ],
} satisfies Stage;
