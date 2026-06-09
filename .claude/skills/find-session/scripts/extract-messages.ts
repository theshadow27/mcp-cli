#!/usr/bin/env bun
/**
 * Extract human-readable user/assistant messages from a Claude Code session JSONL.
 * Strips tool_use, tool_result, thinking blocks — outputs only conversation text.
 *
 * Usage: extract-messages.ts <session.jsonl> [--max-chars N]
 *
 * Output: plain text with USER:/ASSISTANT: prefixes, separated by ---
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let filePath = "";
let maxChars = 80_000; // ~20k tokens, fits comfortably in Haiku context

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max-chars" && i + 1 < args.length) {
    maxChars = parseInt(args[++i], 10);
  } else {
    filePath = args[i];
  }
}

if (!filePath) {
  console.error("Usage: extract-messages.ts <session.jsonl> [--max-chars N]");
  process.exit(1);
}

interface ContentBlock {
  type?: string;
  text?: string;
  input?: unknown;
  content?: string | ContentBlock[];
}

interface Message {
  message?: { role?: string; content?: string | ContentBlock[] };
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text ?? "");
    // Skip tool_use, tool_result, thinking blocks entirely
  }
  return parts.join("\n");
}

const raw = readFileSync(filePath, "utf-8");
const lines = raw.split("\n");
const output: string[] = [];
let totalChars = 0;
let messageCount = 0;
let truncatedAt: number | null = null;

for (const line of lines) {
  if (!line.trim()) continue;
  let obj: Message;
  try { obj = JSON.parse(line); } catch { continue; }

  const role = obj.message?.role;
  if (role !== "user" && role !== "assistant") continue;

  const text = extractText(obj.message?.content).trim();
  if (!text) continue;

  const entry = `${role.toUpperCase()}:\n${text}\n---`;
  messageCount++;

  if (totalChars + entry.length > maxChars) {
    truncatedAt = messageCount;
    // Include a note about truncation
    output.push(`[... truncated at message ${messageCount} of session, ${totalChars} chars shown ...]`);
    break;
  }

  output.push(entry);
  totalChars += entry.length;
}

if (!truncatedAt) {
  console.error(`Extracted ${messageCount} messages, ${totalChars} chars`);
} else {
  console.error(`Extracted ${truncatedAt} messages (truncated at ${maxChars} char limit), ${totalChars} chars`);
}

console.log(output.join("\n"));
