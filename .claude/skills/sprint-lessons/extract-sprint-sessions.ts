#!/usr/bin/env bun
/**
 * extract-sprint-sessions.ts — the data half of the sprint-lessons skill.
 *
 * 1. Derives sprint fenceposts from diary-file commit times (same logic as the
 *    transcript archiver's `transcripts.ts`), so every session lands in exactly
 *    one sprint bucket.
 * 2. For every session JSONL, computes a small DETERMINISTIC digest — token
 *    totals, duration, error/error-type counts, git branches, orchestration
 *    signals, plus BOUNDED evidence samples (first prompt, real user turns,
 *    tool-error samples, synthetic/operational messages, PR links). These are
 *    facts the analysis agents must not hallucinate or recompute.
 * 3. Writes one digest JSON per session under <runDir>/digests/<label>/<id>.json
 *    and emits a self-contained Workflow runner at <runDir>/run.js that feeds the
 *    digest paths (grouped by sprint) into the committed engine
 *    (.claude/workflows/sprint-lessons.js) via `args`.
 *
 * The skill then just calls:  Workflow({ scriptPath: "<runDir>/run.js" })
 *
 *   bun .claude/skills/sprint-lessons/extract-sprint-sessions.ts \
 *     [--sprint N]... [--since-sprint N] [--window 10] \
 *     [--max-sessions-per-sprint N] [--min-user-msgs 1] [--project-repo PATH]
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ─── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flagAll = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
};

const PROJECT_REPO = flag("--project-repo") ?? process.cwd();
const DIARY_DIR = ".claude/diary";
const SPRINTS_DIR = ".claude/sprints";
const ONLY_SPRINTS = new Set(flagAll("--sprint").map((s) => String(Number(s))));
const SINCE_SPRINT = flag("--since-sprint") ? Number(flag("--since-sprint")) : undefined;
const WINDOW = flag("--window") ? Number(flag("--window")) : 10;
const MAX_PER_SPRINT = flag("--max-sessions-per-sprint") ? Number(flag("--max-sessions-per-sprint")) : Infinity;
const MIN_USER_MSGS = flag("--min-user-msgs") ? Number(flag("--min-user-msgs")) : 1;

// Evidence caps — keep each digest small enough to fit comfortably in a haiku prompt.
const CAP = {
  userMessages: 30,
  userMsgChars: 600,
  firstPromptChars: 1800,
  toolErrors: 12,
  toolErrorChars: 320,
  synthetic: 14,
  syntheticChars: 220,
  prLinks: 30,
  branches: 10,
};

// ─── sprint fenceposts (ported from transcripts.ts) ─────────────────────────
type Fence = { sprint: number; at: number };
function gitAddTime(repo: string, rel: string): number | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", repo, "log", "--diff-filter=A", "--follow", "--format=%aI", "--", rel],
      { encoding: "utf-8" },
    );
    const iso = out.trim().split("\n").filter(Boolean).pop();
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function fenceposts(): Fence[] {
  const dir = join(PROJECT_REPO, DIARY_DIR);
  if (!existsSync(dir)) {
    console.error(`diary dir not found: ${dir} (pass --project-repo)`);
    process.exit(1);
  }
  // Authoritative sprint numbers from sprint-<N>.md plan files, if present.
  const sprintsAbs = join(PROJECT_REPO, SPRINTS_DIR);
  let known: Set<number> | null = null;
  if (existsSync(sprintsAbs)) {
    known = new Set(
      readdirSync(sprintsAbs)
        .map((f) => f.match(/^sprint-(\d+)\.md$/)?.[1])
        .filter(Boolean)
        .map(Number),
    );
  }
  const files = readdirSync(dir).filter((f) => /^\d{8}\.\d+\.md$/.test(f)); // YYYYMMDD.N.md
  const raw: Fence[] = [];
  for (const f of files) {
    const sprint = Number(f.match(/^\d{8}\.(\d+)\.md$/)![1]);
    if (known && !known.has(sprint)) continue; // reject same-day sequence suffixes
    const at = gitAddTime(PROJECT_REPO, join(DIARY_DIR, f));
    if (at != null) raw.push({ sprint, at });
  }
  raw.sort((a, b) => a.at - b.at);
  const fences: Fence[] = [];
  let max = -Infinity;
  for (const fp of raw) if (fp.sprint > max) (fences.push(fp), (max = fp.sprint));
  return fences;
}

/** Which sprint bucket an mtime belongs to (string label; "legacy" before first diary). */
function bucketFor(ms: number, fences: Fence[]): string {
  if (fences.length === 0) return "legacy";
  if (ms <= fences[0].at) return "legacy";
  for (let i = 1; i < fences.length; i++) if (ms <= fences[i].at) return String(fences[i].sprint);
  return String(fences[fences.length - 1].sprint + 1); // in-progress sprint, stable label
}

// ─── session discovery ──────────────────────────────────────────────────────
const projectKey = PROJECT_REPO.replace(/[/.]/g, "-");
const sessionsDir = join(homedir(), ".claude", "projects", projectKey);
if (!existsSync(sessionsDir)) {
  console.error(`no sessions dir for this project: ${sessionsDir}`);
  process.exit(1);
}

/** First content timestamp (head read) — preferred over mtime for bucketing. */
function firstContentMs(abs: string): number | null {
  const head = readFileSync(abs, "utf-8").slice(0, 8192);
  const m = head.match(/"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"]*)"/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

const trunc = (s: string, n: number): string => {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** Pull plain text out of a message.content (string | block[]). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string")
      parts.push((b as any).text);
  }
  return parts.join("\n");
}

const STRIP = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-[\s\S]*?<\/local-command-[\s\S]*?>/g,
];
const clean = (t: string): string => {
  for (const p of STRIP) t = t.replace(p, "");
  return t.trim();
};

interface Digest {
  id: string;
  path: string;
  sprint: string;
  label: string;
  sizeBytes: number;
  firstTs: string | null;
  lastTs: string | null;
  durationMin: number | null;
  counts: Record<string, number>;
  tokens: { byModel: Record<string, Record<string, number>>; totalOutput: number; totalInput: number };
  gitBranches: string[];
  signals: Record<string, number>;
  roleHint: string;
  evidence: {
    firstUserPrompt: string;
    userMessages: string[];
    toolErrorSamples: string[];
    syntheticMessages: string[];
    prLinks: { prNumber?: number; prUrl?: string }[];
  };
}

const SIGNAL_PATTERNS: [string, RegExp][] = [
  ["spawn", /mcx\s+claude\s+spawn|claude_spawn/i],
  ["send", /mcx\s+claude\s+send/i],
  ["wait", /mcx\s+claude\s+wait/i],
  ["bye", /mcx\s+claude\s+bye/i],
  ["phaseRun", /mcx\s+phase\s+run|phase\s+install/i],
  ["workItems", /_work_items|work_item\./i],
  ["worktree", /git\s+worktree\s+add|mcx\s+worktree/i],
  ["ghMerge", /gh\s+pr\s+merge/i],
];

function digestSession(abs: string, id: string, sprint: string, label: string): Digest {
  const content = readFileSync(abs, "utf-8");
  const counts: Record<string, number> = {
    userMsgs: 0, assistantMsgs: 0, sidechainMsgs: 0, toolUses: 0,
    toolErrors: 0, apiErrors: 0, syntheticMsgs: 0,
  };
  const byModel: Record<string, Record<string, number>> = {};
  let totalOutput = 0, totalInput = 0;
  const branches = new Set<string>();
  const signals: Record<string, number> = Object.fromEntries(SIGNAL_PATTERNS.map(([k]) => [k, 0]));
  signals.prLinks = 0;
  const userMessages: string[] = [];
  const toolErrorSamples: string[] = [];
  const syntheticMessages: string[] = [];
  const prLinks: { prNumber?: number; prUrl?: string }[] = [];
  let firstUserPrompt = "";
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const line of content.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    if (o.gitBranch) branches.add(o.gitBranch);

    if (o.type === "pr-link") {
      signals.prLinks++;
      if (prLinks.length < CAP.prLinks) prLinks.push({ prNumber: o.prNumber, prUrl: o.prUrl });
      continue;
    }

    if (o.type === "system") {
      if (o.subtype === "api_error") counts.apiErrors++;
      continue;
    }

    if (o.type === "assistant" && o.message) {
      const m = o.message;
      const isSynthetic = m.model === "<synthetic>";
      if (isSynthetic) {
        counts.syntheticMsgs++;
        const t = clean(textOf(m.content));
        if (t && syntheticMessages.length < CAP.synthetic) syntheticMessages.push(trunc(t, CAP.syntheticChars));
      } else {
        counts.assistantMsgs++;
        if (o.isSidechain) counts.sidechainMsgs++;
        if (m.usage && m.model) {
          const u = m.usage;
          const bm = (byModel[m.model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
          bm.input += u.input_tokens || 0;
          bm.output += u.output_tokens || 0;
          bm.cacheRead += u.cache_read_input_tokens || 0;
          bm.cacheCreate += u.cache_creation_input_tokens || 0;
          totalOutput += u.output_tokens || 0;
          totalInput += u.input_tokens || 0;
        }
        // tool_use blocks → count + orchestration signals
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type !== "tool_use") continue;
            counts.toolUses++;
            const probe = `${b.name || ""} ${JSON.stringify(b.input || {})}`;
            for (const [k, rx] of SIGNAL_PATTERNS) if (rx.test(probe)) signals[k]++;
          }
        }
      }
      continue;
    }

    if (o.type === "user" && o.message && !o.isMeta) {
      const mc = o.message.content;
      // tool_result-bearing user turns: scan for errors, don't treat as human text
      if (Array.isArray(mc) && mc.some((b: any) => b?.type === "tool_result")) {
        for (const b of mc) {
          if (b?.type !== "tool_result" || !b.is_error) continue;
          counts.toolErrors++;
          const t = typeof b.content === "string" ? b.content : textOf(b.content) || JSON.stringify(b.content);
          if (t && toolErrorSamples.length < CAP.toolErrors) toolErrorSamples.push(trunc(t, CAP.toolErrorChars));
        }
        continue;
      }
      // a real human turn
      const t = clean(textOf(mc));
      if (!t) continue;
      counts.userMsgs++;
      if (!firstUserPrompt) firstUserPrompt = trunc(t, CAP.firstPromptChars);
      if (userMessages.length < CAP.userMessages) userMessages.push(trunc(t, CAP.userMsgChars));
    }
  }

  const durationMin =
    firstTs && lastTs ? Math.round(((Date.parse(lastTs) - Date.parse(firstTs)) / 60000) * 10) / 10 : null;

  // role heuristic — agents confirm/override this.
  let roleHint = "worker";
  if (signals.spawn > 0 || signals.phaseRun > 0 || signals.workItems > 3 || signals.bye > 0) roleHint = "orchestrator";
  else if (counts.userMsgs <= 2 && counts.toolUses < 10) roleHint = "exploratory";

  return {
    id, path: abs, sprint, label, sizeBytes: statSync(abs).size,
    firstTs, lastTs, durationMin, counts,
    tokens: { byModel, totalOutput, totalInput },
    gitBranches: [...branches].slice(0, CAP.branches),
    signals, roleHint,
    evidence: { firstUserPrompt, userMessages, toolErrorSamples, syntheticMessages, prLinks },
  };
}

// ─── main ────────────────────────────────────────────────────────────────────
const fences = fenceposts();
console.error(`# ${fences.length} sprint fenceposts (last sprint: ${fences.at(-1)?.sprint ?? "?"})`);

const jsonl = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
const byBucket = new Map<string, { abs: string; id: string; ms: number }[]>();
for (const f of jsonl) {
  const abs = join(sessionsDir, f);
  const ms = firstContentMs(abs) ?? statSync(abs).mtimeMs;
  const bucket = bucketFor(ms, fences);
  if (bucket === "legacy") continue; // pre-diary era — no actionable sprint mapping
  const sn = Number(bucket);
  if (ONLY_SPRINTS.size && !ONLY_SPRINTS.has(String(sn))) continue;
  if (SINCE_SPRINT != null && sn < SINCE_SPRINT) continue;
  (byBucket.get(bucket) ?? byBucket.set(bucket, []).get(bucket)!).push({ abs, id: f.replace(".jsonl", ""), ms });
}

// runDir
const ts = new Date(firstContentMs(join(sessionsDir, jsonl[0])) ?? statSync(sessionsDir).mtimeMs)
  .toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = join("/tmp", `sprint-lessons-${ts}-${process.pid}`);
mkdirSync(join(runDir, "digests"), { recursive: true });

const label = (s: string) => (s === "legacy" ? s : `sprint-${s.padStart(4, "0")}`);
const sprintsOut: { sprint: string; label: string; sessions: any[] }[] = [];
let totalSessions = 0;

const order = [...byBucket.keys()].sort((a, b) => Number(a) - Number(b));
for (const bucket of order) {
  const sess = byBucket.get(bucket)!.sort((a, b) => b.ms - a.ms); // newest first
  const lbl = label(bucket);
  const digestDir = join(runDir, "digests", lbl);
  mkdirSync(digestDir, { recursive: true });

  const picked = sess
    .map((s) => digestSession(s.abs, s.id, bucket, lbl))
    .filter((d) => d.counts.userMsgs >= MIN_USER_MSGS)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, MAX_PER_SPRINT);

  const sessions = picked.map((d) => {
    const digestPath = join(digestDir, `${d.id}.json`);
    writeFileSync(digestPath, JSON.stringify(d, null, 1));
    totalSessions++;
    return {
      id: d.id, digestPath, sizeBytes: d.sizeBytes, roleHint: d.roleHint,
      durationMin: d.durationMin, totalOutputTokens: d.tokens.totalOutput,
    };
  });
  if (sessions.length) sprintsOut.push({ sprint: bucket, label: lbl, sessions });
  console.error(`  ${lbl.padEnd(14)} ${String(sessions.length).padStart(4)} sessions`);
}

// ─── emit the /tmp runner workflow ────────────────────────────────────────────
const enginePath = join(PROJECT_REPO, ".claude", "workflows", "sprint-lessons.js");
if (!existsSync(enginePath)) console.error(`! engine not found at ${enginePath} — the runner will fail until it exists`);

const runArgs = { runDir, windowSize: WINDOW, sprints: sprintsOut };
const runner = `export const meta = {
  name: 'sprint-lessons-run',
  description: 'Generated runner: feeds ${totalSessions} session digests across ${sprintsOut.length} sprints into the sprint-lessons engine.',
  phases: [{ title: 'Analyze', detail: 'delegate to .claude/workflows/sprint-lessons.js' }],
}

// Embedded data (digest PATHS only — the digests themselves live on disk under runDir).
const ENGINE = ${JSON.stringify(enginePath)}
const ARGS = ${JSON.stringify(runArgs)}

log(\`sprint-lessons: \${ARGS.sprints.length} sprints, \${ARGS.sprints.reduce((n, s) => n + s.sessions.length, 0)} sessions → engine\`)
return await workflow({ scriptPath: ENGINE }, ARGS)
`;
const runnerPath = join(runDir, "run.js");
writeFileSync(runnerPath, runner);

// machine-readable manifest for the skill
writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ runDir, enginePath, runnerPath, ...runArgs }, null, 2));

console.error(`\n# ${totalSessions} sessions digested into ${sprintsOut.length} sprints`);
console.error(`# runDir:  ${runDir}`);
// stdout: the one line the skill needs — the runner path to hand to the Workflow tool.
console.log(JSON.stringify({ runnerPath, runDir, sprints: sprintsOut.length, sessions: totalSessions, windowSize: WINDOW }));
