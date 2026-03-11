#!/usr/bin/env bun
/**
 * Post-implementation triage: measure actual diff metrics and recommend
 * review depth.
 *
 * Run after implementation, before review. Reads the git diff against
 * the base branch and scores the change.
 *
 * Usage:
 *   bun .claude/skills/estimate/triage.ts                    # diff vs main
 *   bun .claude/skills/estimate/triage.ts --base develop     # diff vs develop
 *   bun .claude/skills/estimate/triage.ts --pr 532           # analyze a specific PR
 *   bun .claude/skills/estimate/triage.ts --json             # machine-readable output
 *
 * Output:
 *   - scrutiny level: "low" or "high"
 *   - recommended pipeline
 *   - metrics used for the decision
 */

import { execSync } from "child_process";
import { type FileEntry, parseNumstat, triage } from "./triage-logic.ts";

function exec(cmd: string): string {
	return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function getFilesFromGitDiff(baseBranch: string): FileEntry[] {
	const diffStat = exec(`git diff ${baseBranch}...HEAD --numstat`);
	return parseNumstat(diffStat);
}

interface PrFile {
	filename: string;
	additions: number;
	deletions: number;
}

function getFilesFromPr(prNumber: number): FileEntry[] {
	const filesJson = exec(
		`gh api repos/{owner}/{repo}/pulls/${prNumber}/files --paginate`,
	);
	const prFiles: PrFile[] = JSON.parse(filesJson);
	return prFiles
		.filter(f => f.filename.endsWith(".ts") && !f.filename.includes("node_modules"))
		.map(f => ({
			path: f.filename,
			additions: f.additions,
			deletions: f.deletions,
		}));
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const baseBranch = baseIdx !== -1 ? args[baseIdx + 1] : "main";
const prIdx = args.indexOf("--pr");
const prNumber = prIdx !== -1 ? parseInt(args[prIdx + 1], 10) : undefined;
const jsonMode = args.includes("--json");

const files = prNumber != null
	? getFilesFromPr(prNumber)
	: getFilesFromGitDiff(baseBranch);
const result = triage(files);

if (jsonMode) {
	console.log(JSON.stringify(result, null, 2));
} else {
	const { scrutiny, pipeline, metrics, reasons } = result;

	console.log(`\n  Scrutiny: ${scrutiny === "high" ? "HIGH" : "LOW"}`);
	console.log(`  Pipeline: ${pipeline}`);
	console.log();
	console.log(`  Metrics:`);
	console.log(`    Src: +${metrics.srcAdditions}/-${metrics.srcDeletions} (${metrics.srcChurn} churn) in ${metrics.srcFiles} files`);
	console.log(`    Tests: ${metrics.testFiles} files`);
	console.log(`    Packages: ${metrics.packages.join(", ") || "(none)"}`);
	console.log(`    Risk areas: ${metrics.riskAreas.join(", ") || "(none)"}`);

	if (reasons.length > 0) {
		console.log(`\n  High scrutiny triggered by:`);
		for (const r of reasons) console.log(`    • ${r}`);
	}
}
