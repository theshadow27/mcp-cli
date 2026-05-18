/**
 * Violation reporter — groups violations by rule, shows guidance once
 * per rule (not once per violation), caps the display at a sensible
 * default with a `--all` override.
 *
 * Output shape (intentionally grep-friendly, file:line:column):
 *
 *     ━━━ rule: shell-injection ━━━
 *     execSync called with interpolated template literal (3 violations)
 *
 *     packages/foo/src/bar.ts:42:5
 *       execSync("git -C …repo… status")        (snippet trimmed for docs)
 *     packages/foo/src/baz.ts:17:3
 *       execSync("echo …msg…")                  (snippet trimmed for docs)
 *
 *     💡 guidance:
 *       • use spawnSync('git', ['-C', repo, 'status'])
 *       • bash $() and backtick survive JSON.stringify
 *       📚 see: CLAUDE.md#no-shell-interpolation
 *
 *     ... and 1 more (use --all to show all)
 */

import type { Logger } from "../../_runner/types";
import type { Rule, Violation } from "./rule";

export interface ReportOptions {
  logger: Logger;
  showAll?: boolean;
  /** Max violations shown per rule when showAll is false. */
  perRuleLimit?: number;
}

export function reportViolations(violations: Violation[], opts: ReportOptions): void {
  const { logger, showAll = false, perRuleLimit = 5 } = opts;
  if (violations.length === 0) {
    logger.info("✨ no rule violations");
    return;
  }

  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const bucket = byRule.get(v.rule.id) ?? [];
    bucket.push(v);
    byRule.set(v.rule.id, bucket);
  }

  for (const [ruleId, group] of byRule) {
    const first = group[0];
    if (!first) continue;
    const rule = first.rule;
    const limit = showAll ? group.length : Math.min(group.length, perRuleLimit);
    logger.warn(`\n━━━ rule: ${ruleId} ━━━`);
    logger.warn(`${rule.scold} (${group.length} violation${group.length === 1 ? "" : "s"})`);
    logger.info("");
    for (let i = 0; i < limit; i++) {
      const v = group[i];
      if (!v) continue;
      logger.info(`  ${v.file}:${v.line}:${v.column}`);
      logger.info(`    ${v.snippet}`);
    }
    if (group.length > limit) {
      logger.info(`  ... and ${group.length - limit} more (use --all to show all)`);
    }
    logger.info("\n💡 guidance:");
    for (const g of rule.guidance) logger.info(`  • ${g}`);
    if (rule.documentation) logger.info(`  📚 see: ${rule.documentation}`);
  }

  logger.error(
    `\n${violations.length} violation${violations.length === 1 ? "" : "s"} across ${byRule.size} rule${byRule.size === 1 ? "" : "s"}`,
  );
}
