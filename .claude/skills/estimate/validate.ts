#!/usr/bin/env bun
/**
 * Validate estimation approaches against actual PR outcomes.
 *
 * Tests multiple techniques from software estimation research:
 *
 *   1. kNN on raw features (baseline)
 *   2. kNN on log-transformed target (handles skewed churn distribution)
 *   3. kNN with embeddings (intent similarity)
 *   4. Gradient boosted stumps (handles non-linear feature interactions)
 *   5. Ordinal regression via cumulative thresholds
 *   6. Analogy-based with calibration (COCOMO-style local calibration)
 *
 * All use leave-one-out cross-validation on 91 data points.
 *
 * Usage:
 *   bun .claude/skills/estimate/validate.ts
 *   bun .claude/skills/estimate/validate.ts --detail
 */

import { openDb } from "./db";
import { unpackEmbedding, cosineSimilarity } from "./embed";

// ─── Data ────────────────────────────────────────────────────────────────────

interface DataPoint {
	prNumber: number;
	title: string;
	srcLoc: number;
	srcBranches: number;
	srcFiles: number;
	testFiles: number;
	packages: number;
	maxDepth: number;
	imports: number;
	embedding: number[] | null;
	churn: number; // src_additions + src_deletions (ground truth)
}

function loadData(): DataPoint[] {
	const db = openDb();
	return (
		db
			.query(
				`SELECT
				p.number, p.title, p.embedding,
				COALESCE(f.f_src_loc, 0) as src_loc,
				COALESCE(f.f_src_branches, 0) as src_branches,
				COALESCE(f.f_src_files, 0) as src_files,
				COALESCE(f.f_test_files, 0) as test_files,
				COALESCE(f.f_packages, 0) as packages,
				COALESCE(f.f_max_depth, 0) as max_depth,
				COALESCE(f.f_imports, 0) as imports,
				p.src_additions + p.src_deletions as churn
			FROM prs p
			JOIN pr_features f ON p.number = f.pr_number
			WHERE p.src_additions + p.src_deletions > 0`,
			)
			.all() as {
			number: number;
			title: string;
			embedding: Buffer | null;
			src_loc: number;
			src_branches: number;
			src_files: number;
			test_files: number;
			packages: number;
			max_depth: number;
			imports: number;
			churn: number;
		}[]
	).map((r) => ({
		prNumber: r.number,
		title: r.title,
		srcLoc: r.src_loc,
		srcBranches: r.src_branches,
		srcFiles: r.src_files,
		testFiles: r.test_files,
		packages: r.packages,
		maxDepth: r.max_depth,
		imports: r.imports,
		embedding: r.embedding ? unpackEmbedding(r.embedding) : null,
		churn: r.churn,
	}));
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
	return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pearson(xs: number[], ys: number[]): number {
	const n = xs.length;
	const mx = mean(xs);
	const my = mean(ys);
	let num = 0, dx2 = 0, dy2 = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - mx, dy = ys[i] - my;
		num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
	}
	const denom = Math.sqrt(dx2 * dy2);
	return denom === 0 ? 0 : num / denom;
}

function spearman(xs: number[], ys: number[]): number {
	const rank = (arr: number[]) => {
		const s = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
		const r = new Array<number>(arr.length);
		for (let i = 0; i < s.length; i++) r[s[i].i] = i + 1;
		return r;
	};
	return pearson(rank(xs), rank(ys));
}

// ─── Feature extraction ──────────────────────────────────────────────────────

type Feature = (d: DataPoint) => number;

// Raw features
const RAW_FEATURES: [string, Feature][] = [
	["srcLoc", (d) => d.srcLoc],
	["srcBranches", (d) => d.srcBranches],
	["srcFiles", (d) => d.srcFiles],
	["testFiles", (d) => d.testFiles],
	["packages", (d) => d.packages],
	["maxDepth", (d) => d.maxDepth],
	["imports", (d) => d.imports],
];

// Engineered features (interactions, ratios)
const ENG_FEATURES: [string, Feature][] = [
	...RAW_FEATURES,
	["branchDensity", (d) => d.srcLoc === 0 ? 0 : d.srcBranches / d.srcLoc],
	["filesXpkgs", (d) => d.srcFiles * d.packages],
	["locXdepth", (d) => d.srcLoc * d.maxDepth],
	["logLoc", (d) => Math.log1p(d.srcLoc)],
	["logBranches", (d) => Math.log1p(d.srcBranches)],
	["logImports", (d) => Math.log1p(d.imports)],
];

function extractFeatures(data: DataPoint[], features: [string, Feature][]): number[][] {
	return data.map((d) => features.map(([, f]) => f(d)));
}

function normalize(matrix: number[][]): { normed: number[][]; mins: number[]; ranges: number[] } {
	const nF = matrix[0].length;
	const mins = new Array<number>(nF).fill(Infinity);
	const maxs = new Array<number>(nF).fill(-Infinity);
	for (const row of matrix) {
		for (let i = 0; i < nF; i++) {
			if (row[i] < mins[i]) mins[i] = row[i];
			if (row[i] > maxs[i]) maxs[i] = row[i];
		}
	}
	const ranges = maxs.map((mx, i) => mx - mins[i]);
	const normed = matrix.map((row) =>
		row.map((v, i) => (ranges[i] === 0 ? 0 : (v - mins[i]) / ranges[i])),
	);
	return { normed, mins, ranges };
}

function euclidean(a: number[], b: number[]): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
	return Math.sqrt(s);
}

// ─── Tier assignment ─────────────────────────────────────────────────────────

function computeBoundaries(churns: number[]): number[] {
	const sorted = [...churns].sort((a, b) => a - b);
	return [0.2, 0.4, 0.6, 0.8].map((p) => sorted[Math.floor(sorted.length * p)]);
}

function toTier(churn: number, bounds: number[]): number {
	for (let i = 0; i < bounds.length; i++) {
		if (churn < bounds[i]) return i;
	}
	return bounds.length;
}

const TIER_NAMES = [
	"sonnet + QA",
	"sonnet + simplify",
	"opus + review(S)",
	"opus + review(O)",
	"opus + codex",
];

// ─── Method 1: kNN (baseline + log-target) ──────────────────────────────────

interface Prediction { actual: number; predicted: number; }

function knnLOO(
	vectors: number[][],
	targets: number[],
	k: number,
	logTarget: boolean,
): Prediction[] {
	const tgt = logTarget ? targets.map((t) => Math.log1p(t)) : targets;
	const preds: Prediction[] = [];

	for (let q = 0; q < vectors.length; q++) {
		const dists: { i: number; d: number }[] = [];
		for (let j = 0; j < vectors.length; j++) {
			if (j === q) continue;
			dists.push({ i: j, d: euclidean(vectors[q], vectors[j]) });
		}
		dists.sort((a, b) => a.d - b.d);
		const topK = dists.slice(0, k);

		// Inverse-distance weighting
		let wSum = 0, wTotal = 0;
		for (const d of topK) {
			const w = d.d === 0 ? 1e6 : 1 / d.d;
			wSum += w * tgt[d.i];
			wTotal += w;
		}
		let pred = wTotal === 0 ? mean(topK.map((d) => tgt[d.i])) : wSum / wTotal;
		if (logTarget) pred = Math.expm1(pred); // back-transform

		preds.push({ actual: targets[q], predicted: pred });
	}
	return preds;
}

// ─── Method 2: Gradient boosted stumps ───────────────────────────────────────
// Minimal implementation — decision stumps with gradient boosting on residuals.
// No external deps required.

interface Stump {
	featureIdx: number;
	threshold: number;
	leftVal: number;
	rightVal: number;
}

function fitStump(X: number[][], residuals: number[]): Stump {
	const n = X.length;
	const nF = X[0].length;
	let bestLoss = Infinity;
	let best: Stump = { featureIdx: 0, threshold: 0, leftVal: 0, rightVal: 0 };

	for (let f = 0; f < nF; f++) {
		// Get unique thresholds (midpoints between sorted values)
		const vals = [...new Set(X.map((row) => row[f]))].sort((a, b) => a - b);
		for (let t = 0; t < vals.length - 1; t++) {
			const thresh = (vals[t] + vals[t + 1]) / 2;
			const leftR: number[] = [];
			const rightR: number[] = [];
			for (let i = 0; i < n; i++) {
				(X[i][f] <= thresh ? leftR : rightR).push(residuals[i]);
			}
			if (leftR.length === 0 || rightR.length === 0) continue;
			const lm = mean(leftR);
			const rm = mean(rightR);
			let loss = 0;
			for (const r of leftR) loss += (r - lm) ** 2;
			for (const r of rightR) loss += (r - rm) ** 2;
			if (loss < bestLoss) {
				bestLoss = loss;
				best = { featureIdx: f, threshold: thresh, leftVal: lm, rightVal: rm };
			}
		}
	}
	return best;
}

function predictStump(stump: Stump, x: number[]): number {
	return x[stump.featureIdx] <= stump.threshold ? stump.leftVal : stump.rightVal;
}

function gbLOO(
	X: number[][],
	targets: number[],
	nTrees: number,
	lr: number,
	logTarget: boolean,
): Prediction[] {
	const tgt = logTarget ? targets.map((t) => Math.log1p(t)) : targets;
	const preds: Prediction[] = [];

	for (let q = 0; q < X.length; q++) {
		// Leave one out
		const trainX = X.filter((_, i) => i !== q);
		const trainY = tgt.filter((_, i) => i !== q);

		// Boosting
		const basePred = mean(trainY);
		const currentPreds = trainY.map(() => basePred);
		const stumps: Stump[] = [];

		for (let t = 0; t < nTrees; t++) {
			const residuals = trainY.map((y, i) => y - currentPreds[i]);
			const stump = fitStump(trainX, residuals);
			stumps.push(stump);
			for (let i = 0; i < trainX.length; i++) {
				currentPreds[i] += lr * predictStump(stump, trainX[i]);
			}
		}

		// Predict held-out
		let pred = basePred;
		for (const stump of stumps) {
			pred += lr * predictStump(stump, X[q]);
		}
		if (logTarget) pred = Math.expm1(pred);

		preds.push({ actual: targets[q], predicted: pred });
	}
	return preds;
}

// ─── Method 3: Ordinal cumulative model ──────────────────────────────────────
// Predict P(tier >= t) for each threshold, pick most likely tier.
// Uses logistic regression on a latent score.

function ordinalLOO(
	X: number[][],
	targets: number[],
	bounds: number[],
): Prediction[] {
	const tiers = targets.map((t) => toTier(t, bounds));
	const nTiers = bounds.length + 1;
	const preds: Prediction[] = [];

	for (let q = 0; q < X.length; q++) {
		const trainX = X.filter((_, i) => i !== q);
		const trainTiers = tiers.filter((_, i) => i !== q);

		// For each threshold t, fit logistic: P(tier >= t) = sigmoid(w · x + b)
		// Simple: use mean churn of tier as latent score, fit linear regression
		const tierMedians: number[] = [];
		for (let t = 0; t < nTiers; t++) {
			const inTier = trainTiers
				.map((tier, i) => (tier === t ? targets.filter((_, j) => j !== q)[i] : NaN))
				.filter((v) => !isNaN(v));
			tierMedians.push(inTier.length > 0 ? mean(inTier) : t === 0 ? 0 : tierMedians[t - 1] * 1.5);
		}

		// Assign latent scores to training data
		const latentY = trainTiers.map((t) => tierMedians[t]);

		// Fit simple linear regression: latent = Xw + b
		// Using normal equation with ridge regularization
		const nF = X[0].length;
		const n = trainX.length;

		// Add bias column
		const Xa = trainX.map((row) => [...row, 1]);
		const XaQ = [...X[q], 1];

		// X^T X + lambda*I
		const lambda = 0.1;
		const XtX: number[][] = Array.from({ length: nF + 1 }, () => new Array(nF + 1).fill(0));
		const XtY = new Array(nF + 1).fill(0);

		for (let i = 0; i < n; i++) {
			for (let j = 0; j < nF + 1; j++) {
				XtY[j] += Xa[i][j] * latentY[i];
				for (let k = 0; k < nF + 1; k++) {
					XtX[j][k] += Xa[i][j] * Xa[i][k];
				}
			}
		}
		for (let j = 0; j < nF + 1; j++) XtX[j][j] += lambda;

		// Solve via Gaussian elimination
		const aug = XtX.map((row, i) => [...row, XtY[i]]);
		const m = nF + 1;
		for (let col = 0; col < m; col++) {
			let maxRow = col;
			for (let row = col + 1; row < m; row++) {
				if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
			}
			[aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
			if (Math.abs(aug[col][col]) < 1e-10) continue;
			for (let row = col + 1; row < m; row++) {
				const f = aug[row][col] / aug[col][col];
				for (let k = col; k <= m; k++) aug[row][k] -= f * aug[col][k];
			}
		}
		const w = new Array(m).fill(0);
		for (let i = m - 1; i >= 0; i--) {
			w[i] = aug[i][m];
			for (let j = i + 1; j < m; j++) w[i] -= aug[i][j] * w[j];
			w[i] /= aug[i][i] || 1;
		}

		// Predict latent score for held-out point
		let latentPred = 0;
		for (let j = 0; j < m; j++) latentPred += w[j] * XaQ[j];

		// Find nearest tier median
		let bestTier = 0;
		let bestDist = Infinity;
		for (let t = 0; t < nTiers; t++) {
			const d = Math.abs(latentPred - tierMedians[t]);
			if (d < bestDist) { bestDist = d; bestTier = t; }
		}

		// Convert back to churn estimate (use tier median)
		preds.push({ actual: targets[q], predicted: tierMedians[bestTier] });
	}
	return preds;
}

// ─── Method 4: Calibrated analogy (COCOMO-style) ────────────────────────────
// Find k nearest neighbors, then fit a local linear calibration:
//   predicted_churn = a * neighbor_mean_churn + b
// where a, b are fitted from all training data's neighbor predictions.

function calibratedAnalogyLOO(
	vectors: number[][],
	targets: number[],
	k: number,
	logTarget: boolean,
): Prediction[] {
	const tgt = logTarget ? targets.map((t) => Math.log1p(t)) : targets;
	const preds: Prediction[] = [];

	for (let q = 0; q < vectors.length; q++) {
		// Step 1: For every training point, compute its kNN prediction (excluding q)
		const trainRawPreds: number[] = [];
		const trainActuals: number[] = [];
		const trainIndices = [...Array(vectors.length).keys()].filter((i) => i !== q);

		for (const ti of trainIndices) {
			const dists: { i: number; d: number }[] = [];
			for (const tj of trainIndices) {
				if (tj === ti) continue;
				dists.push({ i: tj, d: euclidean(vectors[ti], vectors[tj]) });
			}
			dists.sort((a, b) => a.d - b.d);
			const topK = dists.slice(0, k);
			let wSum = 0, wTotal = 0;
			for (const d of topK) {
				const w = d.d === 0 ? 1e6 : 1 / d.d;
				wSum += w * tgt[d.i]; wTotal += w;
			}
			trainRawPreds.push(wTotal === 0 ? mean(topK.map((d) => tgt[d.i])) : wSum / wTotal);
			trainActuals.push(tgt[ti]);
		}

		// Step 2: Fit local linear calibration: actual = a * raw_pred + b
		const n = trainRawPreds.length;
		const mx = mean(trainRawPreds);
		const my = mean(trainActuals);
		let num = 0, den = 0;
		for (let i = 0; i < n; i++) {
			num += (trainRawPreds[i] - mx) * (trainActuals[i] - my);
			den += (trainRawPreds[i] - mx) ** 2;
		}
		const a = den === 0 ? 1 : num / den;
		const b = my - a * mx;

		// Step 3: Raw kNN prediction for held-out point
		const dists: { i: number; d: number }[] = [];
		for (const ti of trainIndices) {
			dists.push({ i: ti, d: euclidean(vectors[q], vectors[ti]) });
		}
		dists.sort((a, b) => a.d - b.d);
		const topK = dists.slice(0, k);
		let wSum = 0, wTotal = 0;
		for (const d of topK) {
			const w = d.d === 0 ? 1e6 : 1 / d.d;
			wSum += w * tgt[d.i]; wTotal += w;
		}
		const rawPred = wTotal === 0 ? mean(topK.map((d) => tgt[d.i])) : wSum / wTotal;

		// Step 4: Apply calibration
		let pred = a * rawPred + b;
		if (logTarget) pred = Math.expm1(pred);
		pred = Math.max(1, pred); // floor at 1

		preds.push({ actual: targets[q], predicted: pred });
	}
	return preds;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

interface Result {
	name: string;
	mae: number;
	rmse: number;
	mape: number;
	tierExact: number;
	tierOff1: number;
	spearmanR: number;
	predictions: Prediction[];
}

function evaluate(name: string, preds: Prediction[], bounds: number[]): Result {
	const n = preds.length;
	let sumAE = 0, sumSE = 0, sumAPE = 0;
	let tierCorrect = 0, tierOff1 = 0;

	for (const p of preds) {
		const e = Math.abs(p.actual - p.predicted);
		sumAE += e;
		sumSE += e * e;
		sumAPE += p.actual === 0 ? 0 : e / p.actual;
		const at = toTier(p.actual, bounds);
		const pt = toTier(p.predicted, bounds);
		if (at === pt) tierCorrect++;
		if (Math.abs(at - pt) <= 1) tierOff1++;
	}

	return {
		name,
		mae: sumAE / n,
		rmse: Math.sqrt(sumSE / n),
		mape: (sumAPE / n) * 100,
		tierExact: tierCorrect / n,
		tierOff1: tierOff1 / n,
		spearmanR: spearman(preds.map((p) => p.actual), preds.map((p) => p.predicted)),
		predictions: preds,
	};
}

// ─── Main ────────────────────────────────────────────────────────────────────

const data = loadData();
const showDetail = process.argv.includes("--detail");
const targets = data.map((d) => d.churn);
const bounds = computeBoundaries(targets);
const hasEmbeddings = data.every((d) => d.embedding !== null);

console.log(`\n${"═".repeat(70)}`);
console.log(`  ESTIMATION METHOD COMPARISON — ${data.length} PRs, leave-one-out CV`);
console.log(`${"═".repeat(70)}`);

const sorted = [...targets].sort((a, b) => a - b);
console.log(`\nChurn: min=${sorted[0]} P25=${sorted[Math.floor(sorted.length * .25)]} median=${sorted[Math.floor(sorted.length * .5)]} P75=${sorted[Math.floor(sorted.length * .75)]} max=${sorted[sorted.length - 1]}`);
console.log(`Tier bounds: ${bounds.join(", ")}`);
console.log(`Skewness: ${(mean(targets.map((t) => ((t - mean(targets)) / Math.sqrt(targets.reduce((s, t2) => s + (t2 - mean(targets)) ** 2, 0) / targets.length)) ** 3))).toFixed(2)} (>1 = right-skewed, log transform likely helps)`);

// Feature correlations
console.log(`\nFeature correlations (Spearman ρ with churn):`);
for (const [name, fn] of ENG_FEATURES) {
	const vals = data.map(fn);
	const rho = spearman(vals, targets);
	const bar = "█".repeat(Math.round(Math.abs(rho) * 30));
	console.log(`  ${name.padEnd(16)} ${(rho >= 0 ? "+" : "") + rho.toFixed(3)}  ${bar}`);
}

// Prepare feature matrices
const rawX = extractFeatures(data, RAW_FEATURES);
const engX = extractFeatures(data, ENG_FEATURES);
const { normed: rawNorm } = normalize(rawX);
const { normed: engNorm } = normalize(engX);

// Embedding-augmented vectors
let embAugNorm: number[][] | null = null;
if (hasEmbeddings) {
	// Append top-5 PCA-like embedding components (via random projection for speed)
	// Actually: just use cosine distance directly for embedding kNN
}

// Run all methods
const results: Result[] = [];

console.log(`\n${"─".repeat(70)}`);
console.log(`  Running methods...`);

// 1a. kNN raw features
for (const k of [3, 5, 7]) {
	const p = knnLOO(rawNorm, targets, k, false);
	results.push(evaluate(`kNN-raw k=${k}`, p, bounds));
}

// 1b. kNN with engineered features
for (const k of [3, 5, 7]) {
	const p = knnLOO(engNorm, targets, k, false);
	results.push(evaluate(`kNN-eng k=${k}`, p, bounds));
}

// 2. kNN with log-transformed target
for (const k of [3, 5, 7]) {
	const p = knnLOO(rawNorm, targets, k, true);
	results.push(evaluate(`kNN-logY k=${k}`, p, bounds));
}
for (const k of [3, 5, 7]) {
	const p = knnLOO(engNorm, targets, k, true);
	results.push(evaluate(`kNN-eng-logY k=${k}`, p, bounds));
}

// 3. Embedding kNN
if (hasEmbeddings) {
	for (const k of [3, 5, 7]) {
		// Build cosine distance matrix
		const embVecs = data.map((d) => d.embedding!);
		const embDists = data.map((_, i) =>
			data.map((_, j) => 1 - cosineSimilarity(embVecs[i], embVecs[j])),
		);

		// kNN using precomputed distances
		const preds: Prediction[] = [];
		for (let q = 0; q < data.length; q++) {
			const dists = embDists[q]
				.map((d, i) => ({ i, d }))
				.filter((d) => d.i !== q)
				.sort((a, b) => a.d - b.d)
				.slice(0, k);
			let wSum = 0, wTotal = 0;
			for (const d of dists) {
				const w = d.d === 0 ? 1e6 : 1 / d.d;
				wSum += w * Math.log1p(targets[d.i]);
				wTotal += w;
			}
			const pred = Math.expm1(wTotal === 0 ? mean(dists.map((d) => Math.log1p(targets[d.i]))) : wSum / wTotal);
			preds.push({ actual: targets[q], predicted: pred });
		}
		results.push(evaluate(`kNN-embed-logY k=${k}`, preds, bounds));
	}
}

// 4. Gradient boosted stumps
for (const [nTrees, lr] of [[10, 0.1], [20, 0.1], [50, 0.05], [20, 0.15]] as [number, number][]) {
	const p = gbLOO(engNorm, targets, nTrees, lr, false);
	results.push(evaluate(`GB t=${nTrees} lr=${lr}`, p, bounds));
}
for (const [nTrees, lr] of [[20, 0.1], [50, 0.05]] as [number, number][]) {
	const p = gbLOO(engNorm, targets, nTrees, lr, true);
	results.push(evaluate(`GB-logY t=${nTrees} lr=${lr}`, p, bounds));
}

// 5. Ordinal regression
{
	const p = ordinalLOO(engNorm, targets, bounds);
	results.push(evaluate("Ordinal-ridge", p, bounds));
}

// 6. Calibrated analogy
for (const k of [3, 5, 7]) {
	const p = calibratedAnalogyLOO(engNorm, targets, k, false);
	results.push(evaluate(`Calib-analog k=${k}`, p, bounds));
}
for (const k of [3, 5, 7]) {
	const p = calibratedAnalogyLOO(engNorm, targets, k, true);
	results.push(evaluate(`Calib-analog-logY k=${k}`, p, bounds));
}

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(70)}`);
console.log(`  RESULTS — sorted by tier accuracy (exact)`);
console.log(`${"═".repeat(70)}`);
console.log(`\n  ${"Method".padEnd(25)} MAE    RMSE   MAPE%   Tier%  ±1%    ρ`);
console.log(`  ${"─".repeat(25)} ─────  ─────  ──────  ─────  ─────  ─────`);

results.sort((a, b) => b.tierExact - a.tierExact || a.mae - b.mae);

for (const r of results) {
	console.log(
		`  ${r.name.padEnd(25)} ${r.mae.toFixed(0).padStart(5)}  ${r.rmse.toFixed(0).padStart(5)}  ${r.mape.toFixed(0).padStart(5)}%  ${(r.tierExact * 100).toFixed(1).padStart(5)}  ${(r.tierOff1 * 100).toFixed(1).padStart(5)}  ${r.spearmanR.toFixed(3)}`,
	);
}

// Highlight winner
const best = results[0];
console.log(`\n  Winner: ${best.name}`);
console.log(`    ${(best.tierExact * 100).toFixed(1)}% exact tier, ${(best.tierOff1 * 100).toFixed(1)}% within ±1, MAE ${best.mae.toFixed(0)} lines, Spearman ρ = ${best.spearmanR.toFixed(3)}`);

// Detail view for winner
if (showDetail) {
	console.log(`\n${"─".repeat(70)}`);
	console.log(`  ${best.name} — per-PR predictions\n`);
	console.log(`  PR#    Actual  Predicted  Tier     Match`);
	console.log(`  ─────  ──────  ─────────  ───────  ─────`);
	for (const p of best.predictions.sort((a, b) => a.actual - b.actual)) {
		const at = toTier(p.actual, bounds);
		const pt = toTier(Math.max(0, p.predicted), bounds);
		const match = at === pt ? "✓" : Math.abs(at - pt) <= 1 ? "~" : "✗";
		const d = data.find((d) => d.churn === p.actual);
		console.log(
			`  ${String(d?.prNumber ?? "?").padStart(5)}  ${String(p.actual).padStart(6)}  ${String(Math.round(p.predicted)).padStart(9)}  ${TIER_NAMES[at].padEnd(7)}  ${match} → ${TIER_NAMES[pt]}`,
		);
	}
}

// Baseline comparison
console.log(`\n${"─".repeat(70)}`);
console.log(`  Baselines for context:`);
const alwaysMedian = targets.map((t) => ({ actual: t, predicted: sorted[Math.floor(sorted.length * .5)] }));
const baselineR = evaluate("Always-median", alwaysMedian, bounds);
console.log(`    Always predict median: MAE ${baselineR.mae.toFixed(0)}, tier ${(baselineR.tierExact * 100).toFixed(1)}%, ±1 ${(baselineR.tierOff1 * 100).toFixed(1)}%`);
const alwaysMean = targets.map((t) => ({ actual: t, predicted: mean(targets) }));
const baselineM = evaluate("Always-mean", alwaysMean, bounds);
console.log(`    Always predict mean:   MAE ${baselineM.mae.toFixed(0)}, tier ${(baselineM.tierExact * 100).toFixed(1)}%, ±1 ${(baselineM.tierOff1 * 100).toFixed(1)}%`);
