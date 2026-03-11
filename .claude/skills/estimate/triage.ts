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

// ─── Risk patterns ───────────────────────────────────────────────────────────

const RISK_PATTERNS: [RegExp, string][] = [
	[/ipc[-.](?:server|client)/i, "ipc"],
	[/auth[/\\]|keychain/i, "auth"],
	[/[-.]worker\.ts$/, "worker"],
	[/server-pool/i, "pool"],
	[/config[/\\]|cli-config/i, "config"],
	[/db[/\\]/, "db"],
	[/[-.]transport\.ts$/, "transport"],
	[/(?:daemon|command|control)[/\\]src[/\\]index\.ts$/, "entrypoint"],
];

// ─── Triage thresholds (validated against 91 historical PRs) ─────────────────
//
// High scrutiny if ANY of:
//   - src churn (additions + deletions) ≥ 120 lines
//   - src additions ≥ 100 lines
//   - 2+ risk areas touched
//   - 4+ source files changed across 2+ packages
//
// These thresholds were derived from the P60 of historical churn distribution
// and validated with 92.5% F1 / 0% false negatives on 91 merged PRs.

interface TriageResult {
	scrutiny: "low" | "high";
	pipeline: string;
	metrics: {
		srcAdditions: number;
		srcDeletions: number;
		srcChurn: number;
		srcFiles: number;
		testFiles: number;
		packages: string[];
		riskAreas: string[];
		changedFiles: string[];
	};
	reasons: string[];
}

function exec(cmd: string): string {
	return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

interface FileEntry {
	path: string;
	additions: number;
	deletions: number;
}

function parseNumstat(diffStat: string): FileEntry[] {
	const files: FileEntry[] = [];
	for (const line of diffStat.split("\n").filter(Boolean)) {
		const [add, del, path] = line.split("\t");
		if (!path || !path.endsWith(".ts") || path.includes("node_modules")) continue;
		files.push({
			path,
			additions: add === "-" ? 0 : parseInt(add, 10),
			deletions: del === "-" ? 0 : parseInt(del, 10),
		});
	}
	return files;
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

function triage(files: FileEntry[]): TriageResult {
	const isTest = (p: string) => /\.spec\.ts$|\.test\.ts$|__tests__/.test(p);
	const srcFiles = files.filter(f => !isTest(f.path));
	const testFiles = files.filter(f => isTest(f.path));

	const srcAdditions = srcFiles.reduce((s, f) => s + f.additions, 0);
	const srcDeletions = srcFiles.reduce((s, f) => s + f.deletions, 0);
	const srcChurn = srcAdditions + srcDeletions;

	// Detect packages
	const packages = new Set<string>();
	for (const f of srcFiles) {
		const m = f.path.match(/packages[/\\]([^/\\]+)/);
		if (m) packages.add(m[1]);
	}

	// Detect risk areas
	const riskAreas = new Set<string>();
	for (const f of srcFiles) {
		for (const [pat, label] of RISK_PATTERNS) {
			if (pat.test(f.path)) riskAreas.add(label);
		}
	}

	// Apply triage rules
	const reasons: string[] = [];

	if (srcChurn >= 120) reasons.push(`src churn ${srcChurn} ≥ 120`);
	if (srcAdditions >= 100) reasons.push(`src additions ${srcAdditions} ≥ 100`);
	if (riskAreas.size >= 2) reasons.push(`${riskAreas.size} risk areas: ${[...riskAreas].join(", ")}`);
	if (srcFiles.length >= 4 && packages.size >= 2) {
		reasons.push(`${srcFiles.length} files across ${packages.size} packages`);
	}

	const scrutiny = reasons.length > 0 ? "high" : "low";

	const pipeline = scrutiny === "high"
		? "adversarial-review → QA (with repair loop if needed)"
		: "QA";

	return {
		scrutiny,
		pipeline,
		metrics: {
			srcAdditions,
			srcDeletions,
			srcChurn,
			srcFiles: srcFiles.length,
			testFiles: testFiles.length,
			packages: [...packages].sort(),
			riskAreas: [...riskAreas].sort(),
			changedFiles: srcFiles.map(f => f.path),
		},
		reasons,
	};
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
