#!/usr/bin/env bun
/**
 * Backfill the estimation database from merged GitHub PRs.
 *
 * For each merged PR:
 *   1. Fetches PR metadata + per-file stats from GitHub API
 *   2. Checks out the merge commit
 *   3. Runs score.ts on each affected .ts source file
 *   4. Extracts modified symbols from the diff
 *   5. Stores everything in SQLite
 *
 * Usage:
 *   bun .claude/skills/estimate/backfill.ts              # backfill all missing
 *   bun .claude/skills/estimate/backfill.ts --force      # re-backfill everything
 *   bun .claude/skills/estimate/backfill.ts --pr 350     # backfill single PR
 *   bun .claude/skills/estimate/backfill.ts --stats      # print summary stats
 *
 * Safe to run repeatedly — skips already-backfilled PRs unless --force.
 */

import { openDb } from "./db";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import ts from "typescript";

const SCORE_SCRIPT = resolve(dirname(import.meta.path), "score.ts");

interface GhPr {
	number: number;
	title: string;
	body: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	headRefName: string;
	mergedAt: string;
	createdAt: string;
	mergeCommit: { oid: string };
	labels: { name: string }[];
	files: { path: string; additions: number; deletions: number }[];
}

function exec(cmd: string, opts?: { cwd?: string }): string {
	return execSync(cmd, {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
		cwd: opts?.cwd,
	}).trim();
}

function tryExec(cmd: string, opts?: { cwd?: string }): string | null {
	try {
		return exec(cmd, opts);
	} catch {
		return null;
	}
}

function parseIssueNumber(title: string): number | null {
	const match = title.match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
	return match ? parseInt(match[1], 10) : null;
}

function isTestFile(path: string): boolean {
	return /\.spec\.ts$|\.test\.ts$|__tests__/.test(path);
}

function isTsSourceFile(path: string): boolean {
	return /\.tsx?$/.test(path) && !path.includes("node_modules");
}

function hashContent(title: string, body: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(title);
	hasher.update(body ?? "");
	return hasher.digest("hex").slice(0, 16);
}

/**
 * Run score.ts on a list of files, returning per-file metrics.
 * Files that don't exist at the current commit are silently skipped.
 */
function scoreFiles(
	files: string[],
	repoRoot: string,
): Map<string, { loc: number; branches: number; imports: number; exports: number; maxDepth: number }> {
	const existing = files.filter((f) => existsSync(resolve(repoRoot, f)));
	if (existing.length === 0) return new Map();

	const result = tryExec(
		`bun ${SCORE_SCRIPT} --modify ${existing.map((f) => `"${f}"`).join(" ")}`,
		{ cwd: repoRoot },
	);
	if (!result) return new Map();

	try {
		const parsed = JSON.parse(result);
		const map = new Map<string, { loc: number; branches: number; imports: number; exports: number; maxDepth: number }>();
		for (const f of parsed.files) {
			map.set(f.file, {
				loc: f.loc,
				branches: f.branches,
				imports: f.imports,
				exports: f.exports,
				maxDepth: f.maxDepth,
			});
		}
		return map;
	} catch {
		return new Map();
	}
}

/**
 * Extract symbols modified in a diff using TypeScript AST.
 *
 * Parses the diff to find added/modified/deleted lines, then finds
 * which top-level declarations those lines belong to.
 */
function extractSymbolsFromDiff(
	diffText: string,
	filePath: string,
	repoRoot: string,
): { symbol: string; kind: string; isAdded: boolean; isModified: boolean; isDeleted: boolean }[] {
	// Parse diff to get line ranges
	const addedLines = new Set<number>();
	const deletedLines = new Set<number>();
	let currentLine = 0;

	for (const line of diffText.split("\n")) {
		const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunkMatch) {
			currentLine = parseInt(hunkMatch[1], 10);
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			addedLines.add(currentLine);
			currentLine++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletedLines.add(currentLine);
			// don't increment — deleted lines don't exist in new file
		} else {
			currentLine++;
		}
	}

	// Try to parse the file at merge commit to find which symbols the lines belong to
	const absPath = resolve(repoRoot, filePath);
	if (!existsSync(absPath)) return [];

	const source = readFileSync(absPath, "utf-8");
	const sourceFile = ts.createSourceFile(
		absPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const symbols: { symbol: string; kind: string; isAdded: boolean; isModified: boolean; isDeleted: boolean }[] = [];
	const seen = new Set<string>();

	function getSymbolName(node: ts.Node): string | null {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isEnumDeclaration(node)
		) {
			return node.name?.text ?? null;
		}
		if (ts.isVariableStatement(node)) {
			const decl = node.declarationList.declarations[0];
			if (ts.isIdentifier(decl.name)) return decl.name.text;
		}
		return null;
	}

	function getSymbolKind(node: ts.Node): string {
		if (ts.isFunctionDeclaration(node)) return "function";
		if (ts.isClassDeclaration(node)) return "class";
		if (ts.isInterfaceDeclaration(node)) return "interface";
		if (ts.isTypeAliasDeclaration(node)) return "type";
		if (ts.isEnumDeclaration(node)) return "enum";
		if (ts.isVariableStatement(node)) return "variable";
		return "unknown";
	}

	ts.forEachChild(sourceFile, (node) => {
		const name = getSymbolName(node);
		if (!name || seen.has(name)) return;

		const startLine =
			sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
		const endLine =
			sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

		let touchedByAdded = false;
		let touchedByDeleted = false;

		for (let line = startLine; line <= endLine; line++) {
			if (addedLines.has(line)) touchedByAdded = true;
			if (deletedLines.has(line)) touchedByDeleted = true;
		}

		if (touchedByAdded || touchedByDeleted) {
			seen.add(name);
			symbols.push({
				symbol: name,
				kind: getSymbolKind(node),
				isAdded: touchedByAdded && !touchedByDeleted,
				isModified: touchedByAdded && touchedByDeleted,
				isDeleted: !touchedByAdded && touchedByDeleted,
			});
		}
	});

	return symbols;
}

function fetchPrs(prNumber?: number): GhPr[] {
	const cmd = prNumber
		? `gh pr view ${prNumber} --json number,title,body,additions,deletions,changedFiles,headRefName,mergedAt,createdAt,mergeCommit,labels,files`
		: `gh pr list --state merged --limit 500 --json number,title,body,additions,deletions,changedFiles,headRefName,mergedAt,createdAt,mergeCommit,labels,files`;

	const result = exec(cmd);
	const parsed = JSON.parse(result);
	return prNumber ? [parsed] : parsed;
}

function backfillPr(pr: GhPr, repoRoot: string, db: ReturnType<typeof openDb>): void {
	const issueNumber = parseIssueNumber(pr.title);
	const hash = hashContent(pr.title, pr.body);

	// Check if already backfilled with same content
	const existing = db
		.query("SELECT content_hash FROM prs WHERE number = ?")
		.get(pr.number) as { content_hash: string | null } | null;

	if (existing?.content_hash === hash) {
		console.error(`  PR #${pr.number}: already up to date, skipping`);
		return;
	}

	const tsFiles = pr.files.filter((f) => isTsSourceFile(f.path));
	const testFiles = tsFiles.filter((f) => isTestFile(f.path));
	const srcFiles = tsFiles.filter((f) => !isTestFile(f.path));

	const testAdditions = testFiles.reduce((s, f) => s + f.additions, 0);
	const testDeletions = testFiles.reduce((s, f) => s + f.deletions, 0);
	const srcAdditions = srcFiles.reduce((s, f) => s + f.additions, 0);
	const srcDeletions = srcFiles.reduce((s, f) => s + f.deletions, 0);

	// Checkout merge commit to score files at that point in time
	let fileMetrics = new Map<string, { loc: number; branches: number; imports: number; exports: number; maxDepth: number }>();
	let diffText = "";

	if (pr.mergeCommit?.oid) {
		const currentHead = tryExec("git rev-parse HEAD", { cwd: repoRoot });
		try {
			tryExec(`git checkout ${pr.mergeCommit.oid} --quiet`, { cwd: repoRoot });

			// Score source files
			const srcPaths = srcFiles.map((f) => f.path);
			fileMetrics = scoreFiles(srcPaths, repoRoot);

			// Get diff for symbol extraction
			diffText = tryExec(
				`git diff ${pr.mergeCommit.oid}~1..${pr.mergeCommit.oid} -- ${srcPaths.map((p) => `"${p}"`).join(" ")}`,
				{ cwd: repoRoot },
			) ?? "";
		} finally {
			if (currentHead) {
				tryExec(`git checkout ${currentHead} --quiet`, { cwd: repoRoot });
			}
		}
	}

	// Aggregate AST metrics
	let totalLoc = 0;
	let totalBranches = 0;
	let totalImports = 0;
	let totalExports = 0;
	let maxDepth = 0;
	const packages = new Set<string>();

	for (const [path, metrics] of fileMetrics) {
		totalLoc += metrics.loc;
		totalBranches += metrics.branches;
		totalImports += metrics.imports;
		totalExports += metrics.exports;
		if (metrics.maxDepth > maxDepth) maxDepth = metrics.maxDepth;
		const pkgMatch = path.match(/packages[/\\]([^/\\]+)/);
		if (pkgMatch) packages.add(pkgMatch[1]);
	}

	// Upsert PR
	db.run(
		`INSERT INTO prs (
			number, title, body, issue_number, merged_at, created_at,
			merge_commit, head_branch, additions, deletions, changed_files,
			test_additions, test_deletions, test_files,
			src_additions, src_deletions, src_files,
			total_loc, total_branches, total_imports, total_exports, max_depth,
			packages_json, labels_json, content_hash, backfilled_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(number) DO UPDATE SET
			title=excluded.title, body=excluded.body, issue_number=excluded.issue_number,
			merged_at=excluded.merged_at, created_at=excluded.created_at,
			merge_commit=excluded.merge_commit, head_branch=excluded.head_branch,
			additions=excluded.additions, deletions=excluded.deletions,
			changed_files=excluded.changed_files,
			test_additions=excluded.test_additions, test_deletions=excluded.test_deletions,
			test_files=excluded.test_files,
			src_additions=excluded.src_additions, src_deletions=excluded.src_deletions,
			src_files=excluded.src_files,
			total_loc=excluded.total_loc, total_branches=excluded.total_branches,
			total_imports=excluded.total_imports, total_exports=excluded.total_exports,
			max_depth=excluded.max_depth,
			packages_json=excluded.packages_json, labels_json=excluded.labels_json,
			content_hash=excluded.content_hash, backfilled_at=excluded.backfilled_at`,
		[
			pr.number, pr.title, pr.body, issueNumber,
			pr.mergedAt, pr.createdAt, pr.mergeCommit?.oid ?? null,
			pr.headRefName, pr.additions, pr.deletions, pr.changedFiles,
			testAdditions, testDeletions, testFiles.length,
			srcAdditions, srcDeletions, srcFiles.length,
			totalLoc, totalBranches, totalImports, totalExports, maxDepth,
			JSON.stringify([...packages].sort()),
			JSON.stringify(pr.labels.map((l) => l.name)),
			hash, new Date().toISOString(),
		],
	);

	// Upsert file metrics
	db.run("DELETE FROM pr_files WHERE pr_number = ?", [pr.number]);
	const insertFile = db.prepare(
		`INSERT INTO pr_files (pr_number, path, additions, deletions, is_test, loc, branches, imports, exports, max_depth)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const f of tsFiles) {
		const metrics = fileMetrics.get(f.path);
		insertFile.run(
			pr.number, f.path, f.additions, f.deletions,
			isTestFile(f.path) ? 1 : 0,
			metrics?.loc ?? null, metrics?.branches ?? null,
			metrics?.imports ?? null, metrics?.exports ?? null,
			metrics?.maxDepth ?? null,
		);
	}

	// Extract and store symbols
	db.run("DELETE FROM pr_symbols WHERE pr_number = ?", [pr.number]);
	if (diffText) {
		const insertSymbol = db.prepare(
			`INSERT OR IGNORE INTO pr_symbols (pr_number, symbol, file_path, kind, is_added, is_modified, is_deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		// Split diff by file
		const fileDiffs = diffText.split(/^diff --git/m).slice(1);
		for (const fileDiff of fileDiffs) {
			const pathMatch = fileDiff.match(/b\/(.+\.tsx?)$/m);
			if (!pathMatch) continue;
			const filePath = pathMatch[1];

			const symbols = extractSymbolsFromDiff(fileDiff, filePath, repoRoot);
			for (const sym of symbols) {
				insertSymbol.run(
					pr.number, sym.symbol, filePath, sym.kind,
					sym.isAdded ? 1 : 0, sym.isModified ? 1 : 0, sym.isDeleted ? 1 : 0,
				);
			}
		}
	}

	// Compute features
	const churn = srcAdditions + srcDeletions;
	db.run(
		`INSERT INTO pr_features (
			pr_number, code_complexity, scope_breadth, risk_surface,
			f_src_loc, f_src_branches, f_src_files, f_test_files,
			f_packages, f_max_depth, f_imports, f_churn
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(pr_number) DO UPDATE SET
			code_complexity=excluded.code_complexity, scope_breadth=excluded.scope_breadth,
			risk_surface=excluded.risk_surface,
			f_src_loc=excluded.f_src_loc, f_src_branches=excluded.f_src_branches,
			f_src_files=excluded.f_src_files, f_test_files=excluded.f_test_files,
			f_packages=excluded.f_packages, f_max_depth=excluded.f_max_depth,
			f_imports=excluded.f_imports, f_churn=excluded.f_churn`,
		[
			pr.number,
			null, null, null, // scores computed by validate.ts
			totalLoc, totalBranches, srcFiles.length, testFiles.length,
			packages.size, maxDepth, totalImports, churn,
		],
	);

	console.error(`  PR #${pr.number}: ${srcFiles.length} src, ${testFiles.length} test, ${fileMetrics.size} scored, +${srcAdditions}/-${srcDeletions}`);
}

function printStats(db: ReturnType<typeof openDb>): void {
	const total = (db.query("SELECT COUNT(*) as n FROM prs").get() as { n: number }).n;
	const withMetrics = (db.query("SELECT COUNT(*) as n FROM prs WHERE total_loc IS NOT NULL").get() as { n: number }).n;
	const totalFiles = (db.query("SELECT COUNT(*) as n FROM pr_files").get() as { n: number }).n;
	const totalSymbols = (db.query("SELECT COUNT(*) as n FROM pr_symbols").get() as { n: number }).n;

	const avgAdditions = db.query("SELECT AVG(additions) as v FROM prs").get() as { v: number };
	const avgDeletions = db.query("SELECT AVG(deletions) as v FROM prs").get() as { v: number };
	const avgFiles = db.query("SELECT AVG(changed_files) as v FROM prs").get() as { v: number };

	const byPackage = db.query(`
		SELECT packages_json, COUNT(*) as n, AVG(src_additions) as avg_add
		FROM prs WHERE packages_json IS NOT NULL
		GROUP BY packages_json ORDER BY n DESC LIMIT 10
	`).all() as { packages_json: string; n: number; avg_add: number }[];

	console.log(`\n=== Estimation Database Stats ===`);
	console.log(`PRs: ${total} (${withMetrics} with AST metrics)`);
	console.log(`Files: ${totalFiles}`);
	console.log(`Symbols: ${totalSymbols}`);
	console.log(`\nAverages:`);
	console.log(`  Additions: ${avgAdditions.v?.toFixed(0)}`);
	console.log(`  Deletions: ${avgDeletions.v?.toFixed(0)}`);
	console.log(`  Files: ${avgFiles.v?.toFixed(1)}`);
	console.log(`\nBy package combination:`);
	for (const row of byPackage) {
		console.log(`  ${row.packages_json}: ${row.n} PRs, avg +${row.avg_add?.toFixed(0)} src lines`);
	}
}

// --- Main ---

const args = process.argv.slice(2);
const force = args.includes("--force");
const statsOnly = args.includes("--stats");
const prIdx = args.indexOf("--pr");
const singlePr = prIdx !== -1 ? parseInt(args[prIdx + 1], 10) : undefined;

const db = openDb();
const repoRoot = exec("git rev-parse --show-toplevel");

if (statsOnly) {
	printStats(db);
	process.exit(0);
}

// Ensure we're on a clean working tree before checking out merge commits
const status = tryExec("git status --porcelain", { cwd: repoRoot });
if (status && status.length > 0) {
	console.error("Warning: working tree has uncommitted changes. Stashing before backfill...");
	tryExec("git stash push -m 'estimate-backfill-auto-stash'", { cwd: repoRoot });
}

console.error(`Fetching merged PRs from GitHub...`);
const prs = fetchPrs(singlePr);
console.error(`Found ${prs.length} merged PRs\n`);

let processed = 0;
let skipped = 0;

for (const pr of prs) {
	if (!force && !singlePr) {
		const existing = db
			.query("SELECT content_hash FROM prs WHERE number = ?")
			.get(pr.number) as { content_hash: string | null } | null;
		const hash = hashContent(pr.title, pr.body);
		if (existing?.content_hash === hash) {
			skipped++;
			continue;
		}
	}

	try {
		backfillPr(pr, repoRoot, db);
		processed++;
	} catch (err) {
		console.error(`  PR #${pr.number}: FAILED — ${err}`);
	}
}

// Restore stash if we made one
tryExec("git stash pop --quiet 2>/dev/null", { cwd: repoRoot });

console.error(`\nDone: ${processed} processed, ${skipped} skipped`);
printStats(db);
