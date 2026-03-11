/**
 * Pure triage logic — extracted for testability.
 *
 * All side-effect-free scoring and parsing lives here.
 * The entry-point script (triage.ts) handles I/O and arg parsing.
 */

// ─── Risk patterns ───────────────────────────────────────────────────────────

export const RISK_PATTERNS: [RegExp, string][] = [
	[/ipc[-.](?:server|client)/i, "ipc"],
	[/auth[/\\]|keychain/i, "auth"],
	[/[-.]worker\.ts$/, "worker"],
	[/server-pool/i, "pool"],
	[/config[/\\]|cli-config/i, "config"],
	[/db[/\\]/, "db"],
	[/[-.]transport\.ts$/, "transport"],
	[/(?:daemon|command|control)[/\\]src[/\\]index\.ts$/, "entrypoint"],
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileEntry {
	path: string;
	additions: number;
	deletions: number;
}

export interface TriageResult {
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

// ─── Pure functions ──────────────────────────────────────────────────────────

export function parseNumstat(diffStat: string): FileEntry[] {
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

export function triage(files: FileEntry[]): TriageResult {
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
