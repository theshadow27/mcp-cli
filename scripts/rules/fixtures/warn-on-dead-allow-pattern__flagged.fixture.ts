/**
 * @rule warn-on-dead-allow-pattern
 * @expect 2
 * @path packages/daemon/src/example.ts
 *
 * String literals containing dead patterns like Bash(*) or Write(*) should
 * be flagged. These look like wildcards but match nothing at runtime.
 */

const deadPatterns = ["Bash(*)", "Write(*)"];
