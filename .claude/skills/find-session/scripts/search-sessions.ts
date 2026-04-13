#!/usr/bin/env bun
/**
 * Search Claude Code session JSONL files for keywords using BM25 ranking.
 *
 * Usage: search-sessions.ts <keyword1> [keyword2] ["literal phrase"] ... [--max N] [--project-filter PATH_SUBSTRING]
 *
 * - Unquoted args are tokenized into individual terms (e.g. "PROJ-123" → ["proj", "123"])
 * - Quoted args (single or double) are treated as literal substring matches
 * - Matches ANY keyword/phrase; ranks by BM25 + phrase bonus + coverage + recency
 * - Self-referencing /find-session queries are penalized
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const K1 = 1.5;
const B = 0.75;
const PHRASE_BONUS = 8.0; // BM25 points added per phrase match (significant)

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

interface Message {
  type?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  cwd?: string;
  timestamp?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  input?: unknown;
  content?: string | ContentBlock[];
}

function extractText(msg: Message): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text ?? "");
    else if (block.type === "tool_use") parts.push(JSON.stringify(block.input ?? {}));
    else if (block.type === "tool_result") {
      const rc = block.content;
      if (typeof rc === "string") parts.push(rc);
      else if (Array.isArray(rc)) {
        for (const rb of rc) {
          if (rb.type === "text") parts.push(rb.text ?? "");
        }
      }
    }
  }
  return parts.join("\n");
}

function getSessionMetadata(lines: string[], filePath: string) {
  const sessionId = basename(filePath, ".jsonl");
  let cwd: string | null = null;
  let firstUserMessage: string | null = null;
  let startTimestamp: string | null = null;

  for (const line of lines) {
    if (!line) continue;
    let obj: Message;
    try { obj = JSON.parse(line); } catch { continue; }

    const role = obj.message?.role;
    if (role === "user" && firstUserMessage === null) {
      firstUserMessage = extractText(obj).slice(0, 300);
      if (obj.cwd) cwd = obj.cwd;
      if (obj.timestamp) startTimestamp = obj.timestamp;
    } else if (obj.cwd && cwd === null) {
      cwd = obj.cwd;
    }
    if (firstUserMessage !== null && cwd !== null) break;
  }

  return { sessionId, cwd, firstUserMessage, startTimestamp };
}

/** Parse args, extracting quoted literals and flags. */
function parseArgs(args: string[]) {
  const phrases: string[] = [];  // literal substring matches
  const words: string[] = [];    // tokenized keywords
  let maxResults = 10;
  let projectFilter: string | null = null;

  // First, rejoin and re-split to handle shell quoting edge cases
  const raw = args.join(" ");
  // Extract quoted phrases (single or double quotes)
  const quotedRe = /(?:"([^"]+)"|'([^']+)')/g;
  const quotedPositions: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(raw)) !== null) {
    phrases.push((m[1] ?? m[2]).toLowerCase());
    quotedPositions.push([m.index, m.index + m[0].length]);
  }

  // Get the non-quoted parts
  let remaining = raw;
  // Remove quoted sections (reverse order to preserve indices)
  for (const [start, end] of [...quotedPositions].reverse()) {
    remaining = remaining.slice(0, start) + " " + remaining.slice(end);
  }

  // Parse remaining tokens for flags and keywords
  const tokens = remaining.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--max" && i + 1 < tokens.length) {
      maxResults = parseInt(tokens[++i], 10);
    } else if (tokens[i] === "--project-filter" && i + 1 < tokens.length) {
      projectFilter = tokens[++i];
    } else {
      words.push(tokens[i]);
    }
  }

  return { phrases, words, maxResults, projectFilter };
}

interface Candidate {
  path: string;
  project: string;
  tf: Map<string, number>;
  docLen: number;
  matchedTerms: string[];
  matchedPhrases: string[];
  mtime: number;
  isFindSessionSelfRef: boolean;
}

async function collectJsonlFiles(claudeDir: string, projectFilter: string | null) {
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

async function main() {
  const { phrases, words, maxResults, projectFilter } = parseArgs(process.argv.slice(2));

  // Tokenized query terms (from unquoted words)
  const queryTerms = [...new Set(words.flatMap(tokenize))];

  if (queryTerms.length === 0 && phrases.length === 0) {
    console.log(JSON.stringify({ error: "No keywords or phrases provided" }));
    process.exit(1);
  }

  // For pre-filtering, we need at least one of: any query term OR any phrase substring
  const preFilterTerms = [...queryTerms, ...phrases];

  const claudeDir = join(homedir(), ".claude");
  const jsonlFiles = await collectJsonlFiles(claudeDir, projectFilter);
  const N = jsonlFiles.length;

  const docFreq = new Map<string, number>();
  const candidates: Candidate[] = [];

  const BATCH_SIZE = 50;
  for (let b = 0; b < jsonlFiles.length; b += BATCH_SIZE) {
    const batch = jsonlFiles.slice(b, b + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ({ path, project }) => {
        let raw: string;
        try { raw = await readFile(path, "utf-8"); } catch { return null; }

        const rawLower = raw.toLowerCase();
        if (!preFilterTerms.some((t) => rawLower.includes(t))) return null;

        const lines = raw.split("\n");
        const textParts: string[] = [];
        let isFindSessionSelfRef = false;

        for (const line of lines) {
          if (!line) continue;
          let obj: Message;
          try { obj = JSON.parse(line); } catch { continue; }
          const role = obj.message?.role;
          if (role === "user" || role === "assistant") {
            const text = extractText(obj);
            textParts.push(text);

            if (
              role === "user" &&
              !isFindSessionSelfRef &&
              text.includes("/find-session")
            ) {
              const textLower = text.toLowerCase();
              if (preFilterTerms.some((t) => textLower.includes(t))) {
                isFindSessionSelfRef = true;
              }
            }
          }
        }

        if (textParts.length === 0) return null;

        const fullText = textParts.join("\n");
        const fullTextLower = fullText.toLowerCase();

        // Tokenized term matching (BM25)
        const tokens = tokenize(fullText);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        const matchedTerms = queryTerms.filter((qt) => (tf.get(qt) ?? 0) > 0);

        // Literal phrase matching (substring)
        const matchedPhrases = phrases.filter((p) => fullTextLower.includes(p));

        if (matchedTerms.length === 0 && matchedPhrases.length === 0) return null;

        let mtime: number;
        try { mtime = (await stat(path)).mtimeMs / 1000; } catch { return null; }

        return { path, project, tf, docLen: tokens.length, matchedTerms, matchedPhrases, mtime, isFindSessionSelfRef };
      })
    );

    for (const r of results) {
      if (!r) continue;
      for (const qt of r.matchedTerms) {
        docFreq.set(qt, (docFreq.get(qt) ?? 0) + 1);
      }
      candidates.push(r);
    }
  }

  if (candidates.length === 0) {
    console.log(JSON.stringify({
      keywords: words, phrases, query_terms: queryTerms,
      total_files_searched: N, candidates_evaluated: 0, results: [],
    }));
    return;
  }

  const avgDl = candidates.reduce((s, c) => s + c.docLen, 0) / candidates.length;
  const now = Date.now() / 1000;
  const totalQueryParts = queryTerms.length + phrases.length;

  const scored = candidates.map((c) => {
    // BM25 for tokenized terms
    let bm25 = 0;
    for (const qt of queryTerms) {
      const tfVal = c.tf.get(qt) ?? 0;
      if (tfVal === 0) continue;
      const df = docFreq.get(qt) ?? 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
      const tfNorm = (tfVal * (K1 + 1)) / (tfVal + K1 * (1 - B + B * c.docLen / avgDl));
      bm25 += idf * tfNorm;
    }

    // Phrase bonus: flat boost per matched phrase (these are high-signal)
    const phraseScore = c.matchedPhrases.length * PHRASE_BONUS;

    // Coverage bonus across all query parts (terms + phrases)
    const totalMatched = c.matchedTerms.length + c.matchedPhrases.length;
    const coverage = totalQueryParts > 0 ? totalMatched / totalQueryParts : 1;
    let score = (bm25 + phraseScore) * (0.5 + 0.5 * coverage);

    // Self-reference penalty
    if (c.isFindSessionSelfRef) score *= 0.1;

    // Recency boost (20% of signal)
    const ageWeeks = Math.max((now - c.mtime) / 604800, 0.1);
    const recency = 1.0 / (1.0 + Math.log(ageWeeks + 1));
    score = score * (0.8 + 0.2 * recency);

    return {
      file: c.path,
      project: c.project,
      matched_keywords: c.matchedTerms,
      matched_phrases: c.matchedPhrases,
      keyword_coverage: `${totalMatched}/${totalQueryParts}`,
      bm25: Math.round(bm25 * 100) / 100,
      phrase_score: Math.round(phraseScore * 100) / 100,
      score: Math.round(score * 100) / 100,
      mtime: c.mtime,
      mtime_human: new Date(c.mtime * 1000).toISOString().slice(0, 16).replace("T", " "),
      self_ref_penalized: c.isFindSessionSelfRef,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, maxResults);

  const enriched = await Promise.all(
    topResults.map(async (r) => {
      let raw: string;
      try { raw = await readFile(r.file, "utf-8"); } catch { return r; }
      const lines = raw.split("\n");
      const meta = getSessionMetadata(lines, r.file);
      return {
        ...r,
        session_id: meta.sessionId,
        cwd: meta.cwd,
        first_user_message: meta.firstUserMessage,
        start_timestamp: meta.startTimestamp,
      };
    })
  );

  console.log(JSON.stringify({
    keywords: words,
    phrases,
    query_terms: queryTerms,
    total_files_searched: N,
    candidates_evaluated: candidates.length,
    results: enriched,
  }, null, 2));
}

main();
