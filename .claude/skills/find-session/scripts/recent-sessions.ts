#!/usr/bin/env bun
/**
 * List recent Claude Code sessions ranked by message timestamps inside the JSONL,
 * not file mtime. mtime is unreliable: Claude often holds the file handle open and
 * mtime is set when the handle closes, which can be long after the user stopped
 * engaging.
 *
 * Usage: recent-sessions.ts [--limit N] [--by user|assistant|any|mtime]
 *                           [--project-filter SUBSTR] [--json]
 *
 * Defaults: --limit 10, --by user
 *
 * Skips /subagents/ files (those are agent-internal, not resumable sessions).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

interface Args {
  limit: number;
  by: "user" | "assistant" | "any" | "mtime";
  projectFilter: string | null;
  asJson: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 10, by: "user", projectFilter: null, asJson: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--limit" && i + 1 < argv.length) a.limit = parseInt(argv[++i], 10);
    else if (t === "--by" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v !== "user" && v !== "assistant" && v !== "any" && v !== "mtime") {
        console.error(`--by must be one of: user, assistant, any, mtime (got ${v})`);
        process.exit(1);
      }
      a.by = v;
    } else if (t === "--project-filter" && i + 1 < argv.length) a.projectFilter = argv[++i];
    else if (t === "--json") a.asJson = true;
    else if (t === "-h" || t === "--help") {
      console.log("Usage: recent-sessions.ts [--limit N] [--by user|assistant|any|mtime] [--project-filter SUBSTR] [--json]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${t}`);
      process.exit(1);
    }
  }
  return a;
}

interface SessionRow {
  path: string;
  sessionId: string;
  project: string;
  cwd: string | null;
  lastUserTs: string | null;
  lastAssistantTs: string | null;
  lastAnyTs: string | null;
  mtime: number;
  userMsgCount: number;
}

async function collectFiles(claudeDir: string, projectFilter: string | null) {
  const files: Array<{ path: string; project: string }> = [];

  const projectsDir = join(claudeDir, "projects");
  try {
    const projectDirs = await readdir(projectsDir, { withFileTypes: true });
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue;
      if (projectFilter && !d.name.toLowerCase().includes(projectFilter.toLowerCase())) continue;
      const entries = await readdir(join(projectsDir, d.name));
      for (const e of entries) {
        if (e.endsWith(".jsonl")) {
          files.push({ path: join(projectsDir, d.name, e), project: d.name });
        }
      }
    }
  } catch { /* no projects dir */ }

  const sessionsDir = join(claudeDir, "sessions");
  try {
    const entries = await readdir(sessionsDir);
    for (const e of entries) {
      if (e.endsWith(".jsonl")) {
        files.push({ path: join(sessionsDir, e), project: "(global)" });
      }
    }
  } catch { /* no sessions dir */ }

  return files;
}

async function inspectFile(path: string, project: string): Promise<SessionRow | null> {
  let raw: string;
  try { raw = await readFile(path, "utf-8"); } catch { return null; }

  const lines = raw.split("\n");
  let lastUserTs: string | null = null;
  let lastAssistantTs: string | null = null;
  let lastAnyTs: string | null = null;
  let cwd: string | null = null;
  let userMsgCount = 0;

  // Walk from the end for the last user/assistant timestamps; bail once both found.
  // We still need a forward pass to count user messages and grab cwd, but only do
  // that if it's worth ranking (i.e., we found at least one timestamp).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let obj: { type?: string; message?: { role?: string }; timestamp?: string; cwd?: string };
    try { obj = JSON.parse(line); } catch { continue; }

    if (!obj.timestamp) continue;
    if (lastAnyTs === null) lastAnyTs = obj.timestamp;

    const role = obj.message?.role;
    if (role === "user" && lastUserTs === null) lastUserTs = obj.timestamp;
    else if (role === "assistant" && lastAssistantTs === null) lastAssistantTs = obj.timestamp;

    if (lastUserTs && lastAssistantTs) break;
  }

  // Forward pass for cwd and user message count
  for (const line of lines) {
    if (!line) continue;
    let obj: { message?: { role?: string }; cwd?: string };
    try { obj = JSON.parse(line); } catch { continue; }
    if (cwd === null && obj.cwd) cwd = obj.cwd;
    if (obj.message?.role === "user") userMsgCount++;
  }

  let mtime = 0;
  try { mtime = (await stat(path)).mtimeMs / 1000; } catch { /* ignore */ }

  return {
    path,
    sessionId: basename(path, ".jsonl"),
    project,
    cwd,
    lastUserTs,
    lastAssistantTs,
    lastAnyTs,
    mtime,
    userMsgCount,
  };
}

function sortKey(r: SessionRow, by: Args["by"]): number {
  const toEpoch = (ts: string | null) => (ts ? new Date(ts).getTime() / 1000 : 0);
  switch (by) {
    case "user": return toEpoch(r.lastUserTs);
    case "assistant": return toEpoch(r.lastAssistantTs);
    case "any": return toEpoch(r.lastAnyTs);
    case "mtime": return r.mtime;
  }
}

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtMtime(s: number): string {
  if (!s) return "—";
  return fmtTs(new Date(s * 1000).toISOString());
}

function cleanProject(project: string, cwd: string | null): string {
  if (cwd) return cwd;
  // Fallback: strip leading dash, replace dashes with slashes — best-effort.
  if (project === "(global)") return project;
  return "/" + project.replace(/^-/, "").replace(/-/g, "/");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const claudeDir = join(homedir(), ".claude");
  const allFiles = await collectFiles(claudeDir, args.projectFilter);

  // Skip subagent files — these are not standalone resumable sessions.
  const files = allFiles.filter((f) => !f.path.includes("/subagents/"));

  const BATCH = 50;
  const rows: SessionRow[] = [];
  for (let b = 0; b < files.length; b += BATCH) {
    const batch = files.slice(b, b + BATCH);
    const results = await Promise.all(batch.map((f) => inspectFile(f.path, f.project)));
    for (const r of results) if (r) rows.push(r);
  }

  rows.sort((a, b) => sortKey(b, args.by) - sortKey(a, args.by));
  const top = rows.slice(0, args.limit);

  if (args.asJson) {
    console.log(JSON.stringify({
      sorted_by: args.by,
      total_sessions: rows.length,
      results: top.map((r) => ({
        session_id: r.sessionId,
        project: cleanProject(r.project, r.cwd),
        last_user: r.lastUserTs,
        last_assistant: r.lastAssistantTs,
        mtime: new Date(r.mtime * 1000).toISOString(),
        user_messages: r.userMsgCount,
        path: r.path,
      })),
    }, null, 2));
    return;
  }

  // Human-readable table
  console.log(`Sorted by: ${args.by} (showing ${top.length} of ${rows.length})\n`);
  console.log("last user        | last asst        | mtime            | msgs | project / session");
  console.log("-----------------+------------------+------------------+------+------------------");
  for (const r of top) {
    const proj = cleanProject(r.project, r.cwd);
    console.log(
      `${fmtTs(r.lastUserTs).padEnd(16)} | ${fmtTs(r.lastAssistantTs).padEnd(16)} | ${fmtMtime(r.mtime).padEnd(16)} | ${String(r.userMsgCount).padStart(4)} | ${proj}`,
    );
    console.log(`                 |                  |                  |      |   resume: claude --resume ${r.sessionId}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
