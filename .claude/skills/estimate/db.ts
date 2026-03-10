/**
 * Estimation database — stores historical PR metrics for data-driven estimation.
 *
 * Uses bun:sqlite. Database lives at ~/.mcp-cli/estimates.db
 */

import { Database } from "bun:sqlite";
import { resolve } from "path";
import { mkdirSync } from "fs";

const DB_DIR = resolve(
	process.env.HOME ?? "~",
	".mcp-cli",
);
const DB_PATH = resolve(DB_DIR, "estimates.db");

export function openDb(): Database {
	mkdirSync(DB_DIR, { recursive: true });
	const db = new Database(DB_PATH);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	migrate(db);
	return db;
}

function migrate(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS prs (
			number          INTEGER PRIMARY KEY,
			title           TEXT NOT NULL,
			body            TEXT,
			issue_number    INTEGER,
			merged_at       TEXT,
			created_at      TEXT,
			merge_commit    TEXT,
			head_branch     TEXT,

			-- Actual outcomes (ground truth)
			additions       INTEGER NOT NULL,
			deletions       INTEGER NOT NULL,
			changed_files   INTEGER NOT NULL,
			test_additions  INTEGER NOT NULL DEFAULT 0,
			test_deletions  INTEGER NOT NULL DEFAULT 0,
			test_files      INTEGER NOT NULL DEFAULT 0,
			src_additions   INTEGER NOT NULL DEFAULT 0,
			src_deletions   INTEGER NOT NULL DEFAULT 0,
			src_files       INTEGER NOT NULL DEFAULT 0,

			-- Computed from score.ts on affected src files at merge commit
			total_loc       INTEGER,
			total_branches  INTEGER,
			total_imports   INTEGER,
			total_exports   INTEGER,
			max_depth       INTEGER,
			packages_json   TEXT,       -- JSON array of package names

			-- Labels
			labels_json     TEXT,       -- JSON array of label names

			-- Content hash for change detection
			content_hash    TEXT,

			-- Text embedding of title + body (1536-dim float32, stored as blob)
			embedding       BLOB,

			-- Backfill metadata
			backfilled_at   TEXT
		)
	`);

	// Migration: add embedding column if missing (for existing DBs)
	try {
		db.run("ALTER TABLE prs ADD COLUMN embedding BLOB");
	} catch {
		// column already exists
	}

	db.run(`
		CREATE TABLE IF NOT EXISTS pr_files (
			pr_number       INTEGER NOT NULL REFERENCES prs(number),
			path            TEXT NOT NULL,
			additions       INTEGER NOT NULL,
			deletions       INTEGER NOT NULL,
			is_test         INTEGER NOT NULL DEFAULT 0,

			-- AST metrics from score.ts (at merge commit)
			loc             INTEGER,
			branches        INTEGER,
			imports         INTEGER,
			exports         INTEGER,
			max_depth       INTEGER,

			PRIMARY KEY (pr_number, path)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS pr_symbols (
			pr_number       INTEGER NOT NULL REFERENCES prs(number),
			symbol          TEXT NOT NULL,
			file_path       TEXT NOT NULL,
			kind            TEXT,           -- function, class, interface, type, variable, enum
			is_added        INTEGER NOT NULL DEFAULT 0,
			is_modified     INTEGER NOT NULL DEFAULT 0,
			is_deleted      INTEGER NOT NULL DEFAULT 0,

			PRIMARY KEY (pr_number, symbol, file_path)
		)
	`);

	// Precomputed features for estimation
	db.run(`
		CREATE TABLE IF NOT EXISTS pr_features (
			pr_number           INTEGER PRIMARY KEY REFERENCES prs(number),

			-- Score components (from score.ts rubric)
			code_complexity     INTEGER,
			scope_breadth       INTEGER,
			risk_surface        INTEGER,

			-- Raw features for regression
			f_src_loc           INTEGER,   -- total LOC of affected source files
			f_src_branches      INTEGER,   -- total branches in affected source files
			f_src_files         INTEGER,   -- number of source files
			f_test_files        INTEGER,   -- number of test files
			f_packages          INTEGER,   -- number of packages touched
			f_max_depth         INTEGER,   -- max nesting depth across files
			f_imports           INTEGER,   -- total imports
			f_churn             INTEGER    -- additions + deletions
		)
	`);

	// Estimation results cache
	db.run(`
		CREATE TABLE IF NOT EXISTS estimates (
			issue_number    INTEGER PRIMARY KEY,
			score           INTEGER NOT NULL,
			model           TEXT NOT NULL,
			pipeline        TEXT NOT NULL,
			features_json   TEXT,         -- JSON snapshot of features used
			neighbors_json  TEXT,         -- JSON array of PR numbers used as neighbors
			estimated_at    TEXT NOT NULL,
			posted          INTEGER NOT NULL DEFAULT 0
		)
	`);
}

export interface PrRow {
	number: number;
	title: string;
	body: string | null;
	issue_number: number | null;
	merged_at: string | null;
	created_at: string | null;
	merge_commit: string | null;
	head_branch: string | null;
	additions: number;
	deletions: number;
	changed_files: number;
	test_additions: number;
	test_deletions: number;
	test_files: number;
	src_additions: number;
	src_deletions: number;
	src_files: number;
	total_loc: number | null;
	total_branches: number | null;
	total_imports: number | null;
	total_exports: number | null;
	max_depth: number | null;
	packages_json: string | null;
	labels_json: string | null;
	content_hash: string | null;
	backfilled_at: string | null;
}

export interface PrFileRow {
	pr_number: number;
	path: string;
	additions: number;
	deletions: number;
	is_test: number;
	loc: number | null;
	branches: number | null;
	imports: number | null;
	exports: number | null;
	max_depth: number | null;
}

export interface PrFeatureRow {
	pr_number: number;
	code_complexity: number | null;
	scope_breadth: number | null;
	risk_surface: number | null;
	f_src_loc: number | null;
	f_src_branches: number | null;
	f_src_files: number | null;
	f_test_files: number | null;
	f_packages: number | null;
	f_max_depth: number | null;
	f_imports: number | null;
	f_churn: number | null;
}

export { DB_PATH };
