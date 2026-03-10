#!/usr/bin/env bun
/**
 * Validate post-implementation triage: can actual diff metrics reliably
 * split PRs into "low scrutiny" vs "high scrutiny"?
 *
 * Uses historical data to find the best binary split.
 * Ground truth for "needed scrutiny" = high churn PRs (top 40%).
 *
 * The insight: we don't need to predict effort before implementation.
 * We implement with opus always, then look at what was actually produced
 * to decide how much validation it needs.
 */

import { openDb } from "./db";

interface PrData {
	number: number;
	title: string;
	srcAdditions: number;
	srcDeletions: number;
	srcFiles: number;
	testFiles: number;
	totalLoc: number;
	totalBranches: number;
	maxDepth: number;
	packages: number;
	churn: number;         // src_additions + src_deletions
	totalChurn: number;    // additions + deletions (including tests)
	riskAreas: string[];
}

function loadData(): PrData[] {
	const db = openDb();
	return (db.query(`
		SELECT
			p.number, p.title,
			p.src_additions, p.src_deletions, p.src_files, p.test_files,
			COALESCE(p.total_loc, 0) as total_loc,
			COALESCE(p.total_branches, 0) as total_branches,
			COALESCE(p.max_depth, 0) as max_depth,
			COALESCE(f.f_packages, 0) as packages,
			p.src_additions + p.src_deletions as churn,
			p.additions + p.deletions as total_churn,
			p.packages_json
		FROM prs p
		JOIN pr_features f ON p.number = f.pr_number
		WHERE p.src_additions + p.src_deletions > 0
	`).all() as {
		number: number; title: string;
		src_additions: number; src_deletions: number;
		src_files: number; test_files: number;
		total_loc: number; total_branches: number; max_depth: number;
		packages: number; churn: number; total_churn: number;
		packages_json: string | null;
	}[]).map(r => {
		const pkgs: string[] = r.packages_json ? JSON.parse(r.packages_json) : [];
		// Check risk by looking at file paths in pr_files
		const files = db.query(
			"SELECT path FROM pr_files WHERE pr_number = ? AND is_test = 0"
		).all(r.number) as { path: string }[];

		const riskAreas: string[] = [];
		const patterns: [RegExp, string][] = [
			[/ipc[-.](?:server|client)/i, "ipc"],
			[/auth[/\\]|keychain/i, "auth"],
			[/[-.]worker\.ts$/, "worker"],
			[/server-pool/i, "pool"],
			[/config[/\\]|cli-config/i, "config"],
			[/db[/\\]/, "db"],
			[/[-.]transport\.ts$/, "transport"],
		];
		for (const f of files) {
			for (const [pat, label] of patterns) {
				if (pat.test(f.path) && !riskAreas.includes(label)) riskAreas.push(label);
			}
		}

		return {
			number: r.number, title: r.title,
			srcAdditions: r.src_additions, srcDeletions: r.src_deletions,
			srcFiles: r.src_files, testFiles: r.test_files,
			totalLoc: r.total_loc, totalBranches: r.total_branches,
			maxDepth: r.max_depth, packages: r.packages,
			churn: r.churn, totalChurn: r.total_churn,
			riskAreas,
		};
	});
}

// ─── Candidate triage signals ────────────────────────────────────────────────

type Signal = (d: PrData) => number;

const SIGNALS: [string, Signal][] = [
	["srcChurn", d => d.churn],
	["totalChurn", d => d.totalChurn],
	["srcFiles", d => d.srcFiles],
	["srcAdditions", d => d.srcAdditions],
	["packages", d => d.packages],
	["touchesRisk", d => d.riskAreas.length > 0 ? 1 : 0],
	["riskCount", d => d.riskAreas.length],
	["multiPkg", d => d.packages > 1 ? 1 : 0],
	["churnXrisk", d => d.churn * (d.riskAreas.length + 1)],
	["filesXpkgs", d => d.srcFiles * d.packages],
	["additionsOnly", d => d.srcAdditions],
	["hasTests", d => d.testFiles > 0 ? 1 : 0],
	["maxDepth", d => d.maxDepth],
];

// ─── Binary split evaluation ─────────────────────────────────────────────────

function evaluateBinarySplit(
	data: PrData[],
	signal: Signal,
	threshold: number,
	highChurnCutoff: number,
): { accuracy: number; precision: number; recall: number; f1: number; falseNeg: number } {
	let tp = 0, fp = 0, tn = 0, fn = 0;

	for (const d of data) {
		const predicted = signal(d) >= threshold ? "high" : "low";
		const actual = d.churn >= highChurnCutoff ? "high" : "low";

		if (predicted === "high" && actual === "high") tp++;
		if (predicted === "high" && actual === "low") fp++;
		if (predicted === "low" && actual === "low") tn++;
		if (predicted === "low" && actual === "high") fn++;
	}

	const accuracy = (tp + tn) / data.length;
	const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
	const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
	const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
	const falseNeg = fn / data.length; // missed high-scrutiny items

	return { accuracy, precision, recall, f1, falseNeg };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const data = loadData();
const churns = data.map(d => d.churn).sort((a, b) => a - b);

// "High scrutiny" = top 40% by churn (roughly where opus+review makes sense)
const highCutoff = churns[Math.floor(churns.length * 0.6)];
const highCount = data.filter(d => d.churn >= highCutoff).length;
const lowCount = data.length - highCount;

console.log(`\n${"═".repeat(70)}`);
console.log(`  POST-IMPLEMENTATION TRIAGE VALIDATION — ${data.length} PRs`);
console.log(`${"═".repeat(70)}`);
console.log(`\n  Split: churn < ${highCutoff} = "low scrutiny" (${lowCount} PRs), ≥ ${highCutoff} = "high scrutiny" (${highCount} PRs)`);

// Find best threshold for each signal
console.log(`\n  Signal           Best Thresh  Accuracy  Precision  Recall  F1      FN%`);
console.log(`  ───────────────  ───────────  ────────  ─────────  ──────  ──────  ──────`);

interface BestResult {
	name: string;
	threshold: number;
	accuracy: number;
	precision: number;
	recall: number;
	f1: number;
	falseNeg: number;
}

const bestResults: BestResult[] = [];

for (const [name, signal] of SIGNALS) {
	const values = data.map(signal).sort((a, b) => a - b);
	const unique = [...new Set(values)];

	let bestF1 = 0;
	let bestThresh = 0;
	let bestResult = { accuracy: 0, precision: 0, recall: 0, f1: 0, falseNeg: 1 };

	for (const thresh of unique) {
		const result = evaluateBinarySplit(data, signal, thresh, highCutoff);
		// Optimize for F1 but penalize false negatives heavily
		// (missing a high-scrutiny PR is worse than over-reviewing a simple one)
		const score = result.f1 - result.falseNeg * 0.5;
		if (score > bestF1 - bestResult.falseNeg * 0.5 || (result.f1 > bestF1 && result.falseNeg <= bestResult.falseNeg)) {
			if (result.f1 > bestF1) {
				bestF1 = result.f1;
				bestThresh = thresh;
				bestResult = result;
			}
		}
	}

	bestResults.push({ name, threshold: bestThresh, ...bestResult });

	console.log(
		`  ${name.padEnd(17)} ${String(bestThresh).padStart(11)}  ` +
		`${(bestResult.accuracy * 100).toFixed(1).padStart(7)}%  ` +
		`${(bestResult.precision * 100).toFixed(1).padStart(8)}%  ` +
		`${(bestResult.recall * 100).toFixed(1).padStart(5)}%  ` +
		`${(bestResult.f1 * 100).toFixed(1).padStart(5)}%  ` +
		`${(bestResult.falseNeg * 100).toFixed(1).padStart(5)}%`
	);
}

// Sort by F1
bestResults.sort((a, b) => b.f1 - a.f1);

console.log(`\n  Winner: ${bestResults[0].name} ≥ ${bestResults[0].threshold}`);
console.log(`    F1: ${(bestResults[0].f1 * 100).toFixed(1)}%, Recall: ${(bestResults[0].recall * 100).toFixed(1)}%, False Negatives: ${(bestResults[0].falseNeg * 100).toFixed(1)}%`);

// ─── Composite rules ─────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(70)}`);
console.log(`  Composite rules (combining signals):\n`);

// Rule: high if ANY of these are true
const compositeRules: [string, (d: PrData) => boolean][] = [
	[
		"srcChurn≥100 OR multiPkg OR touchesRisk",
		d => d.churn >= 100 || d.packages > 1 || d.riskAreas.length > 0,
	],
	[
		"srcChurn≥80 OR (multiPkg AND srcFiles≥3)",
		d => d.churn >= 80 || (d.packages > 1 && d.srcFiles >= 3),
	],
	[
		"srcChurn≥120 OR riskCount≥2",
		d => d.churn >= 120 || d.riskAreas.length >= 2,
	],
	[
		"srcAdditions≥60 OR multiPkg OR touchesRisk",
		d => d.srcAdditions >= 60 || d.packages > 1 || d.riskAreas.length > 0,
	],
	[
		"churnXrisk≥100 OR srcFiles≥4",
		d => d.churn * (d.riskAreas.length + 1) >= 100 || d.srcFiles >= 4,
	],
	[
		"srcChurn≥100 OR (touchesRisk AND srcFiles≥2)",
		d => d.churn >= 100 || (d.riskAreas.length > 0 && d.srcFiles >= 2),
	],
];

console.log(`  Rule                                          Acc%   Prec%  Rec%   F1%    FN%`);
console.log(`  ────────────────────────────────────────────  ─────  ─────  ─────  ─────  ─────`);

for (const [name, rule] of compositeRules) {
	let tp = 0, fp = 0, tn = 0, fn = 0;
	for (const d of data) {
		const pred = rule(d) ? "high" : "low";
		const actual = d.churn >= highCutoff ? "high" : "low";
		if (pred === "high" && actual === "high") tp++;
		if (pred === "high" && actual === "low") fp++;
		if (pred === "low" && actual === "low") tn++;
		if (pred === "low" && actual === "high") fn++;
	}
	const acc = (tp + tn) / data.length;
	const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
	const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
	const f1 = prec + rec === 0 ? 0 : 2 * prec * rec / (prec + rec);
	const fnr = fn / data.length;

	console.log(
		`  ${name.padEnd(46)} ${(acc * 100).toFixed(1).padStart(4)}%  ` +
		`${(prec * 100).toFixed(1).padStart(4)}%  ${(rec * 100).toFixed(1).padStart(4)}%  ` +
		`${(f1 * 100).toFixed(1).padStart(4)}%  ${(fnr * 100).toFixed(1).padStart(4)}%`
	);
}

// ─── Show false negatives for best rule ──────────────────────────────────────

console.log(`\n${"─".repeat(70)}`);
console.log(`  Misclassifications for top rules:\n`);

for (const [name, rule] of compositeRules.slice(0, 2)) {
	console.log(`  ${name}:`);
	const falseNegs = data.filter(d => !rule(d) && d.churn >= highCutoff);
	const falsePos = data.filter(d => rule(d) && d.churn < highCutoff);

	if (falseNegs.length > 0) {
		console.log(`    False negatives (high scrutiny, predicted low):`);
		for (const d of falseNegs.sort((a, b) => b.churn - a.churn)) {
			console.log(`      PR #${d.number} (churn=${d.churn}, ${d.srcFiles}f, ${d.packages}pkg, risk=[${d.riskAreas.join(",")}]): ${d.title.slice(0, 60)}`);
		}
	}
	if (falsePos.length > 0) {
		console.log(`    False positives (low scrutiny, predicted high) [${falsePos.length} PRs]:`);
		for (const d of falsePos.sort((a, b) => b.churn - a.churn).slice(0, 5)) {
			console.log(`      PR #${d.number} (churn=${d.churn}, ${d.srcFiles}f, ${d.packages}pkg, risk=[${d.riskAreas.join(",")}]): ${d.title.slice(0, 60)}`);
		}
		if (falsePos.length > 5) console.log(`      ... and ${falsePos.length - 5} more`);
	}
	console.log();
}
