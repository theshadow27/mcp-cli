import type { Stage } from "am-i-done";

import { ciPartition } from "./_lib/partition";
import { DAEMON_TEST_PATHS } from "./_lib/test-paths";

/** CI's second partition: the daemon and integration tests, sequential, with #1004 tolerance. */
export default {
  id: "test-daemon",
  description: "daemon tests (sequential; #1004 segfault retry + crash-after-pass tolerance)",
  phase: "test",
  modes: ["ci"],
  after: ["test-non-daemon"],
  cores: "max",
  command: ciPartition(DAEMON_TEST_PATHS, "test_daemon"),
  onFailure: [
    "real failure: see the captured output above",
    "post-test Bun crash (#1004): a summary showing `0 fail` would have been treated as a pass",
    "log artefact: build/test-logs/test_daemon.txt (retry: test_daemon_retry.txt)",
  ],
} satisfies Stage;
