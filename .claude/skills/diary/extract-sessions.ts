#!/usr/bin/env bun
/**
 * Extract text content from Claude Code session JSONL files.
 * Groups sessions by date, filters to substantial ones, strips tool_use and system tags.
 * Outputs a JSON manifest to stdout for the diary skill to consume.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { homedir } from "os";

const MAX_CHARS_PER_SESSION = 25_000;
const MAX_SESSIONS_PER_DATE = 6;
const MIN_USER_MESSAGES = 5; // skip sessions with fewer than this many user messages

// Parse args: optional --date YYYYMMDD to force regeneration of a specific day
const forceDate = process.argv.includes("--date")
  ? process.argv[process.argv.indexOf("--date") + 1]
  : undefined;

// Derive project key from cwd (same logic Claude Code uses: replace / and . with -)
const cwd = process.cwd();
const projectKey = cwd.replace(/[/.]/g, "-");
const sessionsDir = join(homedir(), ".claude", "projects", projectKey);
const diaryDir = join(cwd, ".claude", "diary");

if (!existsSync(sessionsDir)) {
  console.error(`No sessions directory found: ${sessionsDir}`);
  process.exit(1);
}

// XML tags to strip from content
const STRIP_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
];

function stripTags(text: string): string {
  let result = text;
  for (const pattern of STRIP_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

interface SessionInfo {
  id: string;
  path: string;
  size: number;
  userMessageCount: number;
  date: string; // YYYYMMDD
}

/** Count user messages in a JSONL file (quick scan — just checks type field) */
function countUserMessages(path: string): number {
  let count = 0;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" && !obj.isMeta) count++;
    } catch {
      // skip malformed lines
    }
  }
  return count;
}

// Scan session files
const sessions: SessionInfo[] = [];
for (const file of readdirSync(sessionsDir)) {
  if (!file.endsWith(".jsonl")) continue;
  const path = join(sessionsDir, file);
  const stat = statSync(path);

  const userMsgCount = countUserMessages(path);
  if (userMsgCount < MIN_USER_MESSAGES) continue;

  const mtime = stat.mtime;
  const date = `${mtime.getFullYear()}${String(mtime.getMonth() + 1).padStart(2, "0")}${String(mtime.getDate()).padStart(2, "0")}`;
  sessions.push({
    id: file.replace(".jsonl", ""),
    path,
    size: stat.size,
    userMessageCount: userMsgCount,
    date,
  });
}

// Group by date
const byDate = new Map<string, SessionInfo[]>();
for (const s of sessions) {
  const list = byDate.get(s.date) ?? [];
  list.push(s);
  byDate.set(s.date, list);
}

// Check which dates already have diary entries
const existingEntries = new Set<string>();
if (existsSync(diaryDir)) {
  for (const file of readdirSync(diaryDir)) {
    if (file.match(/^\d{8}\.md$/)) {
      existingEntries.add(file.replace(".md", ""));
    }
  }
}

// Extract text from a session file
function extractText(sessionPath: string): string {
  const texts: string[] = [];
  let totalChars = 0;

  const content = readFileSync(sessionPath, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const msgType = obj.type as string;
    if (msgType !== "user" && msgType !== "assistant") continue;

    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const msgContent = message.content;
    const extracted: string[] = [];

    if (typeof msgContent === "string") {
      if (msgContent.startsWith("<local-command") || msgContent.startsWith("<command-name>")) {
        continue;
      }
      const cleaned = stripTags(msgContent);
      if (cleaned.length > 10) extracted.push(cleaned);
    } else if (Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
          const text = stripTags(String((block as Record<string, unknown>).text ?? ""));
          if (text.length > 10) extracted.push(text);
        }
      }
    }

    const role = msgType.toUpperCase();
    for (const t of extracted) {
      const entry = `[${role}]: ${t.slice(0, 1500)}`;
      texts.push(entry);
      totalChars += entry.length;
      if (totalChars >= MAX_CHARS_PER_SESSION) {
        return texts.join("\n\n");
      }
    }
  }

  return texts.join("\n\n");
}

// Process each date
const outputDir = join(tmpdir(), "session_extracts");
mkdirSync(outputDir, { recursive: true });

interface ManifestEntry {
  date: string;
  formattedDate: string;
  extractPath: string;
  sessionCount: number;
  totalSize: number;
}

const manifest: ManifestEntry[] = [];

for (const [date, dateSessions] of [...byDate.entries()].sort()) {
  if (existingEntries.has(date) && date !== forceDate) {
    console.error(`Skipping ${date} — diary entry already exists`);
    continue;
  }

  // Take top sessions by size
  const topSessions = dateSessions
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_SESSIONS_PER_DATE);

  const combined: string[] = [];
  for (const s of topSessions) {
    const text = extractText(s.path);
    if (text) {
      combined.push(`=== SESSION ${s.id.slice(0, 8)} (${s.userMessageCount} user msgs, ${(s.size / 1024 / 1024).toFixed(1)}MB) ===\n${text}`);
    }
  }

  const extractPath = join(outputDir, `${date}.txt`);
  writeFileSync(extractPath, combined.join("\n\n" + "=".repeat(80) + "\n\n"));

  const formatted = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  manifest.push({
    date,
    formattedDate: formatted,
    extractPath,
    sessionCount: topSessions.length,
    totalSize: topSessions.reduce((sum, s) => sum + s.size, 0),
  });

  console.error(`${date}: extracted ${topSessions.length} sessions (${(topSessions.reduce((s, x) => s + x.size, 0) / 1024 / 1024).toFixed(1)}MB)`);
}

// Output manifest as JSON to stdout
console.log(JSON.stringify({ diaryDir, dates: manifest }, null, 2));
