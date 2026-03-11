import { describe, expect, test } from "bun:test";
import { type FileEntry, RISK_PATTERNS, parseNumstat, triage } from "./triage-logic.ts";

describe("parseNumstat", () => {
	test("returns empty array for empty input", () => {
		expect(parseNumstat("")).toEqual([]);
	});

	test("returns empty array for whitespace-only input", () => {
		expect(parseNumstat("  \n  \n")).toEqual([]);
	});

	test("parses a single .ts file", () => {
		const result = parseNumstat("10\t5\tpackages/core/src/foo.ts");
		expect(result).toEqual([
			{ path: "packages/core/src/foo.ts", additions: 10, deletions: 5 },
		]);
	});

	test("parses multiple files", () => {
		const input = [
			"10\t5\tpackages/core/src/foo.ts",
			"3\t1\tpackages/daemon/src/bar.ts",
		].join("\n");
		expect(parseNumstat(input)).toHaveLength(2);
	});

	test("handles binary files (dashes for add/del)", () => {
		const result = parseNumstat("-\t-\tpackages/core/src/binary.ts");
		expect(result).toEqual([
			{ path: "packages/core/src/binary.ts", additions: 0, deletions: 0 },
		]);
	});

	test("filters out non-.ts files", () => {
		const input = [
			"10\t5\tpackages/core/src/foo.ts",
			"20\t10\tREADME.md",
			"5\t2\tpackage.json",
		].join("\n");
		expect(parseNumstat(input)).toHaveLength(1);
		expect(parseNumstat(input)[0].path).toBe("packages/core/src/foo.ts");
	});

	test("filters out node_modules paths", () => {
		const input = "10\t5\tnode_modules/@types/bun/index.ts";
		expect(parseNumstat(input)).toEqual([]);
	});
});

describe("triage", () => {
	function file(path: string, additions: number, deletions: number): FileEntry {
		return { path, additions, deletions };
	}

	test("returns low scrutiny when all metrics are below thresholds", () => {
		const result = triage([
			file("packages/core/src/foo.ts", 10, 5),
		]);
		expect(result.scrutiny).toBe("low");
		expect(result.pipeline).toBe("QA");
		expect(result.reasons).toHaveLength(0);
	});

	test("triggers high scrutiny on churn >= 120", () => {
		const result = triage([
			file("packages/core/src/foo.ts", 60, 60),
		]);
		expect(result.scrutiny).toBe("high");
		expect(result.reasons).toEqual(
			expect.arrayContaining([expect.stringContaining("churn 120")]),
		);
	});

	test("triggers high scrutiny on additions >= 100", () => {
		const result = triage([
			file("packages/core/src/foo.ts", 100, 0),
		]);
		expect(result.scrutiny).toBe("high");
		expect(result.reasons).toEqual(
			expect.arrayContaining([expect.stringContaining("additions 100")]),
		);
	});

	test("triggers high scrutiny on 2+ risk areas", () => {
		const result = triage([
			file("packages/daemon/src/ipc-server.ts", 5, 2),
			file("packages/daemon/src/auth/token.ts", 5, 2),
		]);
		expect(result.scrutiny).toBe("high");
		expect(result.metrics.riskAreas).toEqual(
			expect.arrayContaining(["auth", "ipc"]),
		);
		expect(result.reasons).toEqual(
			expect.arrayContaining([expect.stringContaining("risk areas")]),
		);
	});

	test("triggers high scrutiny on 4+ files across 2+ packages", () => {
		const result = triage([
			file("packages/core/src/a.ts", 5, 0),
			file("packages/core/src/b.ts", 5, 0),
			file("packages/daemon/src/c.ts", 5, 0),
			file("packages/daemon/src/d.ts", 5, 0),
		]);
		expect(result.scrutiny).toBe("high");
		expect(result.reasons).toEqual(
			expect.arrayContaining([expect.stringContaining("4 files across 2 packages")]),
		);
	});

	test("does not trigger cross-package rule with 4+ files in 1 package", () => {
		const result = triage([
			file("packages/core/src/a.ts", 5, 0),
			file("packages/core/src/b.ts", 5, 0),
			file("packages/core/src/c.ts", 5, 0),
			file("packages/core/src/d.ts", 5, 0),
		]);
		expect(result.reasons.some(r => r.includes("packages"))).toBe(false);
	});

	test("separates test files from src files in metrics", () => {
		const result = triage([
			file("packages/core/src/foo.ts", 10, 5),
			file("packages/core/src/foo.spec.ts", 50, 20),
		]);
		expect(result.metrics.srcFiles).toBe(1);
		expect(result.metrics.testFiles).toBe(1);
		expect(result.metrics.srcAdditions).toBe(10);
	});

	test("reports correct packages", () => {
		const result = triage([
			file("packages/core/src/a.ts", 1, 0),
			file("packages/daemon/src/b.ts", 1, 0),
			file("packages/command/src/c.ts", 1, 0),
		]);
		expect(result.metrics.packages).toEqual(["command", "core", "daemon"]);
	});
});

describe("RISK_PATTERNS", () => {
	test("matches ipc-server and ipc-client paths", () => {
		const ipcPattern = RISK_PATTERNS.find(([, label]) => label === "ipc")![0];
		expect(ipcPattern.test("packages/core/src/ipc-server.ts")).toBe(true);
		expect(ipcPattern.test("packages/core/src/ipc-client.ts")).toBe(true);
		expect(ipcPattern.test("packages/core/src/ipc.server.ts")).toBe(true);
	});

	test("matches auth paths", () => {
		const authPattern = RISK_PATTERNS.find(([, label]) => label === "auth")![0];
		expect(authPattern.test("packages/daemon/src/auth/token.ts")).toBe(true);
		expect(authPattern.test("packages/daemon/src/keychain.ts")).toBe(true);
	});

	test("matches worker paths", () => {
		const workerPattern = RISK_PATTERNS.find(([, label]) => label === "worker")![0];
		expect(workerPattern.test("packages/daemon/src/alias-worker.ts")).toBe(true);
		expect(workerPattern.test("packages/daemon/src/session.worker.ts")).toBe(true);
	});
});
