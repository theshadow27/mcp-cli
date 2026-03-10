#!/usr/bin/env bun
/**
 * Generate text embeddings for PR title+body and store in the estimation DB.
 *
 * Uses OpenAI's text-embedding-3-small (1536 dimensions).
 * Stores as float32 blob for efficient cosine similarity computation.
 *
 * Usage:
 *   bun .claude/skills/estimate/embed.ts                # embed all PRs missing embeddings
 *   bun .claude/skills/estimate/embed.ts --force        # re-embed everything
 *   bun .claude/skills/estimate/embed.ts --pr 350       # embed single PR
 *   bun .claude/skills/estimate/embed.ts --text "text"  # embed arbitrary text, print vector
 *
 * Requires OPENAI_API_KEY in environment or .env file.
 */

import { openDb } from "./db";
import { resolve } from "path";

async function loadEnv(): Promise<void> {
	const envPath = resolve(import.meta.dir, "../../../.env");
	const envFile = await Bun.file(envPath).text().catch(() => "");
	for (const line of envFile.split("\n")) {
		const match = line.match(/^(\w+)=(.+)$/);
		if (match && !process.env[match[1]]) {
			process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
		}
	}
}

function getApiKey(): string {
	const key = process.env.OPENAI_API_KEY;
	if (!key) {
		console.error("OPENAI_API_KEY not found in environment or .env");
		process.exit(1);
	}
	return key;
}

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const BATCH_SIZE = 50; // OpenAI supports up to 2048 inputs per request

interface EmbeddingResponse {
	data: { embedding: number[]; index: number }[];
	usage: { prompt_tokens: number; total_tokens: number };
}

async function getEmbeddings(texts: string[]): Promise<number[][]> {
	const apiKey = getApiKey();
	const resp = await fetch("https://api.openai.com/v1/embeddings", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: MODEL,
			input: texts,
			dimensions: DIMENSIONS,
		}),
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`OpenAI API error ${resp.status}: ${body}`);
	}

	const json = (await resp.json()) as EmbeddingResponse;
	// Sort by index to maintain input order
	const sorted = json.data.sort((a, b) => a.index - b.index);
	console.error(`  Embedded ${texts.length} texts (${json.usage.total_tokens} tokens)`);
	return sorted.map((d) => d.embedding);
}

/** Pack float64[] into a Float32Array blob for compact storage */
export function packEmbedding(vec: number[]): Buffer {
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer);
}

/** Unpack a stored blob back into number[] */
export function unpackEmbedding(blob: Buffer): number[] {
	const f32 = new Float32Array(
		blob.buffer,
		blob.byteOffset,
		blob.byteLength / 4,
	);
	return Array.from(f32);
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

function prepareText(title: string, body: string | null): string {
	// Combine title + body, strip HTML comments and markdown noise
	let text = title;
	if (body) {
		// Remove HTML comments, code blocks, and test plan boilerplate
		const cleaned = body
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/```[\s\S]*?```/g, "")
			.replace(/## Test plan[\s\S]*$/i, "")
			.replace(/🤖 Generated with.*$/m, "")
			.trim();
		if (cleaned) text += "\n\n" + cleaned;
	}
	// Truncate to ~8000 chars (well within token limits)
	return text.slice(0, 8000);
}

// --- Main (only runs when executed directly) ---

if (import.meta.main) {
	await loadEnv();

	const args = process.argv.slice(2);
	const force = args.includes("--force");
	const prIdx = args.indexOf("--pr");
	const singlePr = prIdx !== -1 ? parseInt(args[prIdx + 1], 10) : undefined;
	const textIdx = args.indexOf("--text");

	if (textIdx !== -1) {
		const text = args[textIdx + 1];
		const [vec] = await getEmbeddings([text]);
		console.log(JSON.stringify(vec));
		process.exit(0);
	}

	const db = openDb();

	let prs: { number: number; title: string; body: string | null }[];

	if (singlePr) {
		prs = db
			.query("SELECT number, title, body FROM prs WHERE number = ?")
			.all(singlePr) as typeof prs;
	} else if (force) {
		prs = db.query("SELECT number, title, body FROM prs").all() as typeof prs;
	} else {
		prs = db
			.query("SELECT number, title, body FROM prs WHERE embedding IS NULL")
			.all() as typeof prs;
	}

	if (prs.length === 0) {
		console.error("All PRs already have embeddings. Use --force to re-embed.");
		process.exit(0);
	}

	console.error(`Embedding ${prs.length} PRs...`);

	const update = db.prepare("UPDATE prs SET embedding = ? WHERE number = ?");

	for (let i = 0; i < prs.length; i += BATCH_SIZE) {
		const batch = prs.slice(i, i + BATCH_SIZE);
		const texts = batch.map((pr) => prepareText(pr.title, pr.body));

		const embeddings = await getEmbeddings(texts);

		for (let j = 0; j < batch.length; j++) {
			const blob = packEmbedding(embeddings[j]);
			update.run(blob, batch[j].number);
		}
	}

	const total = (
		db.query("SELECT COUNT(*) as n FROM prs WHERE embedding IS NOT NULL").get() as {
			n: number;
		}
	).n;
	console.error(`\nDone. ${total}/${prs.length + total - prs.length} PRs have embeddings.`);
}
