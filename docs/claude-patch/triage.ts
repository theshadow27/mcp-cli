#!/usr/bin/env bun
/**
 * WS-patch triage tool (#1808 follow-up).
 *
 * For each claude-code version in a range, ensure we have the darwin-arm64
 * binary (reuse a local copy if present, else download from the GCS release
 * bucket), then scan it for the byte-signatures the patcher depends on:
 *   - "claude-staging.fedstart.com"  (the string the v1 strategy replaces)
 *   - the two hardcoded allowlist hosts
 *   - the "sL_" fedstart-origins source array marker
 *   - the IPv6 replacement literal (should be 0 on an unpatched binary)
 *
 * Emits a per-version JSON record + a summary table. This is the cheap
 * triage pass that tells us WHERE the count==4 assumption breaks, so the
 * expensive decompile work can focus on boundary versions.
 *
 * Usage:
 *   bun triage.ts                 # full range .120-.173
 *   bun triage.ts 150 160         # inclusive sub-range (patch numbers)
 *   bun triage.ts --keep          # keep downloaded binaries (default: keep)
 *   bun triage.ts --no-keep       # delete after scan to save disk
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GCS = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const PLATFORM = "darwin-arm64";
const HERE = import.meta.dir;
const BIN_DIR = join(HERE, "binaries");
const NOTES_DIR = join(HERE, "notes");
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(NOTES_DIR, { recursive: true });

const FEDSTART = "claude-staging.fedstart.com";
const REPLACEMENT = "[000:000:000:000:000:0:0:1]";
const HOST_PROD = "api.anthropic.com";
const HOST_STAGING = "api-staging.anthropic.com";

const args = process.argv.slice(2);
const keep = !args.includes("--no-keep");
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const lo = nums[0] ?? 120;
const hi = nums[1] ?? 173;

/** Local sources we can reuse instead of downloading. */
function localSourceFor(version: string): string | null {
  const candidates = [
    join(homedir(), ".local/share/claude/versions", version),
    join(homedir(), ".local/share/mcp-cli-archive/claude-code", `claude-${version}`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function countOccurrences(buf: Buffer, needle: string): number {
  const n = Buffer.from(needle, "utf-8");
  let count = 0;
  let i = buf.indexOf(n, 0);
  while (i !== -1) {
    count++;
    i = buf.indexOf(n, i + n.length);
  }
  return count;
}

/** Return byte offsets of every occurrence (non-overlapping). */
function offsetsOf(buf: Buffer, needle: string): number[] {
  const n = Buffer.from(needle, "utf-8");
  const out: number[] = [];
  let i = buf.indexOf(n, 0);
  while (i !== -1) {
    out.push(i);
    i = buf.indexOf(n, i + n.length);
  }
  return out;
}

/** Printable-ish context window around an offset, control bytes shown as ·. */
function contextAt(buf: Buffer, off: number, before = 48, after = 80): string {
  const start = Math.max(0, off - before);
  const end = Math.min(buf.length, off + after);
  const slice = buf.subarray(start, end);
  let s = "";
  for (const b of slice) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
  return s;
}

interface VersionReport {
  version: string;
  source: "local" | "download" | "missing";
  size: number;
  sha256?: string;
  fedstartCount: number;
  replacementCount: number;
  hostProdCount: number;
  hostStagingCount: number;
  fedstartOffsets: number[];
  contexts: string[];
  v1StrategyValidates: boolean; // existing strategy asserts exactly 4
  error?: string;
}

function sha256(path: string): string {
  const r = spawnSync("shasum", ["-a", "256", path], { encoding: "utf-8" });
  return (r.stdout || "").trim().split(/\s+/)[0] ?? "";
}

function ensureBinary(version: string): { path: string; source: "local" | "download" | "missing" } {
  const local = localSourceFor(version);
  const dest = join(BIN_DIR, version);
  if (local) {
    if (!existsSync(dest)) {
      try {
        symlinkSync(local, dest);
      } catch {
        /* ignore */
      }
    }
    return { path: local, source: "local" };
  }
  if (existsSync(dest) && statSync(dest).size > 1_000_000) {
    return { path: dest, source: "download" };
  }
  const url = `${GCS}/${version}/${PLATFORM}/claude`;
  const r = spawnSync("curl", ["-fsSL", "-o", dest, url], { encoding: "utf-8", timeout: 600_000 });
  if (r.status !== 0 || !existsSync(dest)) {
    return { path: dest, source: "missing" };
  }
  return { path: dest, source: "download" };
}

function scan(version: string): VersionReport {
  const { path, source } = ensureBinary(version);
  if (source === "missing") {
    return {
      version,
      source,
      size: 0,
      fedstartCount: 0,
      replacementCount: 0,
      hostProdCount: 0,
      hostStagingCount: 0,
      fedstartOffsets: [],
      contexts: [],
      v1StrategyValidates: false,
      error: "download failed / version not published",
    };
  }
  const buf = readFileSync(path);
  const offsets = offsetsOf(buf, FEDSTART);
  const fedstartCount = offsets.length;
  const rep: VersionReport = {
    version,
    source,
    size: buf.length,
    sha256: sha256(path),
    fedstartCount,
    replacementCount: countOccurrences(buf, REPLACEMENT),
    hostProdCount: countOccurrences(buf, HOST_PROD),
    hostStagingCount: countOccurrences(buf, HOST_STAGING),
    fedstartOffsets: offsets,
    contexts: offsets.map((o) => contextAt(buf, o)),
    v1StrategyValidates: fedstartCount === 4 && countOccurrences(buf, REPLACEMENT) === 0,
  };
  return rep;
}

const allVersions: string[] = [];
for (let p = lo; p <= hi; p++) allVersions.push(`2.1.${p}`);

const reports: VersionReport[] = [];
for (const v of allVersions) {
  process.stderr.write(`scanning ${v} ... `);
  const rep = scan(v);
  reports.push(rep);
  writeFileSync(join(NOTES_DIR, `${v}.scan.json`), JSON.stringify(rep, null, 2));
  process.stderr.write(
    `${rep.source} fedstart=${rep.fedstartCount} prod=${rep.hostProdCount} staging=${rep.hostStagingCount}${rep.error ? ` ERROR(${rep.error})` : ""}\n`,
  );
  if (!keep && rep.source === "download") {
    try {
      rmSync(join(BIN_DIR, v));
    } catch {
      /* ignore */
    }
  }
}

// Summary table
const lines: string[] = [];
lines.push("| version | src | size(MB) | fedstart | prod | staging | replacement | v1-validates |");
lines.push("|---------|-----|----------|----------|------|---------|-------------|--------------|");
for (const r of reports) {
  lines.push(
    `| ${r.version} | ${r.source} | ${(r.size / 1e6).toFixed(0)} | ${r.fedstartCount} | ${r.hostProdCount} | ${r.hostStagingCount} | ${r.replacementCount} | ${r.v1StrategyValidates ? "✓" : "✗"} |`,
  );
}
const summary = lines.join("\n");
writeFileSync(join(NOTES_DIR, "_summary.md"), `${summary}\n`);
writeFileSync(join(NOTES_DIR, "_summary.json"), JSON.stringify(reports, null, 2));
console.log(summary);

// Boundary analysis
const counts = new Map<number, string[]>();
for (const r of reports) {
  if (r.source === "missing") continue;
  const k = r.fedstartCount;
  if (!counts.has(k)) counts.set(k, []);
  counts.get(k)?.push(r.version);
}
console.log("\n# fedstart-count buckets");
for (const [k, vs] of [...counts.entries()].sort((a, b) => b[0] - a[0])) {
  console.log(`count=${k}: ${vs[0]} .. ${vs[vs.length - 1]} (${vs.length} versions)`);
}
