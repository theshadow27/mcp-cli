#!/usr/bin/env bun
/**
 * Complexity scoring for TypeScript source files.
 *
 * Uses the TypeScript compiler API to walk the AST and count:
 *   - Lines of code (non-blank, non-comment)
 *   - Branching nodes (if, else, switch/case, try/catch, ternary, &&, ||, ??)
 *   - Import count (import declarations + dynamic imports)
 *   - Export count
 *   - Max nesting depth of control flow
 *   - Package directories touched
 *
 * Files are tagged into two categories:
 *   --modify <files...>   Existing files being changed (default if no flag)
 *   --analog <files...>   Existing files structurally similar to NEW code that
 *                         must be written. Used as a complexity proxy when the
 *                         issue requires creating new files.
 *   --new-files <N>       Number of new files that will be created (not yet on disk)
 *   --new-packages <N>    Number of new packages touched (beyond those in --modify)
 *
 * Usage:
 *   bun .claude/skills/estimate/score.ts --modify server-pool.ts --analog claude-server.ts
 *   bun .claude/skills/estimate/score.ts index.ts                   # defaults to --modify
 *   bun .claude/skills/estimate/score.ts --analog claude-server.ts claude-session-worker.ts --new-files 4
 *
 * Output: JSON to stdout
 */

import ts from "typescript";
import { readFileSync } from "fs";
import { resolve, relative } from "path";

interface FileMetrics {
	file: string;
	category: "modify" | "analog";
	loc: number;
	branches: number;
	imports: number;
	exports: number;
	maxDepth: number;
}

interface AggregateMetrics {
	files: FileMetrics[];
	modify: {
		loc: number;
		branches: number;
		fileCount: number;
		packages: string[];
	};
	analog: {
		loc: number;
		branches: number;
		fileCount: number;
		packages: string[];
	};
	newFiles: number;
	scores: {
		codeComplexity: number;
		scopeBreadth: number;
		estimatedChurn: number;
		riskSurface: number;
		total: number;
		breakdown: {
			modifyLocScore: number;
			modifyBranchScore: number;
			analogLocScore: number;
			analogBranchScore: number;
			fileScore: number;
			pkgScore: number;
			newFileScore: number;
		};
	};
}

// Risk zones — files matching these patterns get risk points
const RISK_ZONES: [RegExp, number, string][] = [
	[/ipc[-.](?:server|client|\.)/i, 5, "IPC protocol"],
	[/auth[/\\]|keychain/i, 5, "auth/tokens"],
	[/(?:daemon|command|control)[/\\]src[/\\]index\.ts$/, 4, "entrypoint"],
	[/[-.]worker\.ts$/, 4, "worker"],
	[/server-pool\.ts$/, 4, "server pool"],
	[/config[/\\]|cli-config|config\.ts$/, 3, "config"],
	[/db[/\\]/, 3, "persistence"],
	[/build|scripts[/\\]|bunfig/, 3, "build"],
	[/[-.]transport\.ts$/, 3, "transport"],
	[/commands[/\\]/, 1, "CLI command"],
	[/\.spec\.ts$/, 0, "test"],
];

function countLoc(sourceFile: ts.SourceFile): number {
	const text = sourceFile.getFullText();
	let loc = 0;
	let inBlockComment = false;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (inBlockComment) {
			if (line.includes("*/")) inBlockComment = false;
			continue;
		}
		if (line.startsWith("/*")) {
			if (!line.includes("*/")) inBlockComment = true;
			continue;
		}
		if (line === "" || line.startsWith("//")) continue;
		loc++;
	}
	return loc;
}

function isBranchingBinary(node: ts.BinaryExpression): boolean {
	return (
		node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
		node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
		node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
	);
}

function analyzeFile(
	filePath: string,
	category: "modify" | "analog",
): FileMetrics {
	const absPath = resolve(filePath);
	const source = readFileSync(absPath, "utf-8");
	const sourceFile = ts.createSourceFile(
		absPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	let branches = 0;
	let imports = 0;
	let exports = 0;
	let maxDepth = 0;

	function walk(node: ts.Node, depth: number): void {
		let newDepth = depth;

		switch (node.kind) {
			// Branching
			case ts.SyntaxKind.IfStatement:
			case ts.SyntaxKind.SwitchStatement:
			case ts.SyntaxKind.CaseClause:
			case ts.SyntaxKind.DefaultClause:
			case ts.SyntaxKind.TryStatement:
			case ts.SyntaxKind.CatchClause:
			case ts.SyntaxKind.ConditionalExpression: // ternary
				branches++;
				newDepth = depth + 1;
				break;

			case ts.SyntaxKind.ForStatement:
			case ts.SyntaxKind.ForInStatement:
			case ts.SyntaxKind.ForOfStatement:
			case ts.SyntaxKind.WhileStatement:
			case ts.SyntaxKind.DoStatement:
				branches++;
				newDepth = depth + 1;
				break;

			// Binary operators: &&, ||, ??
			case ts.SyntaxKind.BinaryExpression:
				if (isBranchingBinary(node as ts.BinaryExpression)) {
					branches++;
				}
				break;

			// Imports
			case ts.SyntaxKind.ImportDeclaration:
				imports++;
				break;
			case ts.SyntaxKind.CallExpression: {
				const call = node as ts.CallExpression;
				if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
					imports++; // dynamic import()
				}
				break;
			}

			// Exports
			case ts.SyntaxKind.ExportDeclaration:
			case ts.SyntaxKind.ExportAssignment:
				exports++;
				break;
			default:
				// Check for export modifier on declarations
				if (
					ts.isVariableStatement(node) ||
					ts.isFunctionDeclaration(node) ||
					ts.isClassDeclaration(node) ||
					ts.isInterfaceDeclaration(node) ||
					ts.isTypeAliasDeclaration(node) ||
					ts.isEnumDeclaration(node)
				) {
					const modifiers = ts.getModifiers(node);
					if (
						modifiers?.some(
							(m) => m.kind === ts.SyntaxKind.ExportKeyword,
						)
					) {
						exports++;
					}
				}
				break;
		}

		if (newDepth > maxDepth) maxDepth = newDepth;
		ts.forEachChild(node, (child) => walk(child, newDepth));
	}

	walk(sourceFile, 0);

	return {
		file: relative(process.cwd(), absPath),
		category,
		loc: countLoc(sourceFile),
		branches,
		imports,
		exports,
		maxDepth,
	};
}

function detectPackages(files: FileMetrics[]): string[] {
	const pkgs = new Set<string>();
	for (const f of files) {
		const match = f.file.match(/packages[/\\]([^/\\]+)/);
		if (match) pkgs.add(match[1]);
	}
	return [...pkgs].sort();
}

function riskScore(files: FileMetrics[]): number {
	const matched = new Set<string>();
	let score = 0;
	for (const f of files) {
		for (const [pattern, points, label] of RISK_ZONES) {
			if (pattern.test(f.file) && !matched.has(label)) {
				matched.add(label);
				score += points;
			}
		}
	}
	return Math.min(score, 20);
}

function tieredScore(value: number, tiers: [number, number][]): number {
	for (const [threshold, score] of tiers) {
		if (value < threshold) return score;
	}
	return tiers[tiers.length - 1][1];
}

function computeScores(
	files: FileMetrics[],
	newFiles: number,
	newPackages: number,
): AggregateMetrics["scores"] {
	const modifyFiles = files.filter((f) => f.category === "modify");
	const analogFiles = files.filter((f) => f.category === "analog");

	const modifyLoc = modifyFiles.reduce((s, f) => s + f.loc, 0);
	const modifyBranches = modifyFiles.reduce((s, f) => s + f.branches, 0);
	const analogLoc = analogFiles.reduce((s, f) => s + f.loc, 0);
	const analogBranches = analogFiles.reduce((s, f) => s + f.branches, 0);

	const modifyPkgs = detectPackages(modifyFiles);
	const analogPkgs = detectPackages(analogFiles);
	const allPkgs = new Set([...modifyPkgs, ...analogPkgs]);

	// A. Code Complexity (0-30)
	// Modify files: scored on what you're changing IN
	// Analog files: scored on what you're BUILDING (similar scale, represents new code volume)
	const locTiers: [number, number][] = [
		[50, 2],
		[150, 6],
		[300, 12],
		[500, 20],
		[Infinity, 30],
	];
	const branchTiers: [number, number][] = [
		[5, 0],
		[15, 3],
		[30, 6],
		[Infinity, 10],
	];

	const modifyLocScore = tieredScore(modifyLoc, locTiers);
	const modifyBranchScore = tieredScore(modifyBranches, branchTiers);
	const analogLocScore = tieredScore(analogLoc, locTiers);
	const analogBranchScore = tieredScore(analogBranches, branchTiers);

	// Take the higher of modify vs analog complexity — they represent different
	// dimensions but shouldn't double-count. A pure greenfield issue uses analog
	// scores; a pure modification issue uses modify scores; mixed uses max.
	const codeComplexity = Math.min(
		Math.max(
			modifyLocScore + modifyBranchScore,
			analogLocScore + analogBranchScore,
		),
		30,
	);

	// B. Scope Breadth (0-20)
	// Total files = modify files + analog files + new files (new files not on disk yet)
	const totalFileCount = modifyFiles.length + analogFiles.length + newFiles;
	const fileScore = tieredScore(totalFileCount, [
		[2, 2],
		[4, 5],
		[7, 10],
		[11, 15],
		[Infinity, 20],
	]);

	const totalPkgCount = allPkgs.size + newPackages;
	const pkgScore = tieredScore(totalPkgCount, [
		[2, 0],
		[3, 3],
		[4, 5],
		[Infinity, 8],
	]);

	const newFileScore = tieredScore(newFiles, [
		[1, 0],
		[2, 1],
		[4, 3],
		[Infinity, 5],
	]);

	const scopeBreadth = Math.min(fileScore + pkgScore + newFileScore, 20);

	// C. Estimated Churn (0-15)
	// For modify: fraction of existing LOC being touched
	// For analog: full LOC of analog (you're writing that much new code)
	// Use max of the two
	const churnLoc = Math.max(modifyLoc, analogLoc);
	const estimatedChurn = tieredScore(churnLoc, [
		[20, 2],
		[50, 5],
		[150, 8],
		[300, 12],
		[Infinity, 15],
	]);

	// D. Risk Surface (0-20)
	// Both modify and analog files contribute — if the analog is in a risky
	// zone, the new code integrating with it will be risky too
	const risk = riskScore(files);

	const total = codeComplexity + scopeBreadth + estimatedChurn + risk;

	return {
		codeComplexity,
		scopeBreadth,
		estimatedChurn,
		riskSurface: risk,
		total: Math.min(total, 100),
		breakdown: {
			modifyLocScore,
			modifyBranchScore,
			analogLocScore,
			analogBranchScore,
			fileScore,
			pkgScore,
			newFileScore,
		},
	};
}

// --- Arg parsing ---

interface ParsedArgs {
	modify: string[];
	analog: string[];
	newFiles: number;
	newPackages: number;
}

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		modify: [],
		analog: [],
		newFiles: 0,
		newPackages: 0,
	};

	let currentCategory: "modify" | "analog" = "modify";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--modify") {
			currentCategory = "modify";
		} else if (arg === "--analog") {
			currentCategory = "analog";
		} else if (arg === "--new-files") {
			result.newFiles = parseInt(argv[++i], 10) || 0;
		} else if (arg === "--new-packages") {
			result.newPackages = parseInt(argv[++i], 10) || 0;
		} else if (!arg.startsWith("--")) {
			result[currentCategory].push(arg);
		}
	}

	return result;
}

// --- Main ---

const args = parseArgs(process.argv.slice(2));

if (args.modify.length === 0 && args.analog.length === 0) {
	console.error(
		"Usage: score.ts [--modify] <file...> [--analog <file...>] [--new-files N] [--new-packages N]",
	);
	console.error("");
	console.error("  --modify <files>     Existing files being changed (default)");
	console.error("  --analog <files>     Existing files similar to new code being written");
	console.error("  --new-files <N>      Number of new files to be created");
	console.error("  --new-packages <N>   New packages beyond those in --modify");
	process.exit(1);
}

const allInputs: { path: string; category: "modify" | "analog" }[] = [
	...args.modify.map((p) => ({ path: p, category: "modify" as const })),
	...args.analog.map((p) => ({ path: p, category: "analog" as const })),
];

const validInputs: typeof allInputs = [];
const errors: string[] = [];

for (const input of allInputs) {
	try {
		readFileSync(resolve(input.path));
		validInputs.push(input);
	} catch {
		errors.push(input.path);
	}
}

if (errors.length > 0) {
	console.error(
		`Warning: skipped ${errors.length} unreadable files: ${errors.join(", ")}`,
	);
}

const files = validInputs.map((input) => analyzeFile(input.path, input.category));
const modifyFiles = files.filter((f) => f.category === "modify");
const analogFiles = files.filter((f) => f.category === "analog");

const scores = computeScores(files, args.newFiles, args.newPackages);

const result: AggregateMetrics = {
	files,
	modify: {
		loc: modifyFiles.reduce((s, f) => s + f.loc, 0),
		branches: modifyFiles.reduce((s, f) => s + f.branches, 0),
		fileCount: modifyFiles.length,
		packages: detectPackages(modifyFiles),
	},
	analog: {
		loc: analogFiles.reduce((s, f) => s + f.loc, 0),
		branches: analogFiles.reduce((s, f) => s + f.branches, 0),
		fileCount: analogFiles.length,
		packages: detectPackages(analogFiles),
	},
	newFiles: args.newFiles,
	scores,
};

console.log(JSON.stringify(result, null, 2));
