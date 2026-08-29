/**
 * Named threads + post policy for a site.
 *
 * A site's watched/known threads are declared in
 * `~/.mcp-cli/sites/<site>/threads.yaml` (a `.json` file of the same shape is
 * accepted as a fallback). Each entry maps a human name to a thread id, a post
 * policy, and optional notes / watch flag:
 *
 *   general:
 *     id: "19:...@thread.v2"
 *     post: deny          # "allow" | "deny" (default "allow")
 *     notes: "read-only broadcast channel"
 *     watch: true         # auto-start the Trouter watcher for this site at boot
 *
 * Two things consume this file:
 *   1. Name resolution — a name used anywhere a threadId is accepted resolves to
 *      its id, and output records carry the name when known.
 *   2. Post policy — `post: "deny"` is enforced at the site tool layer, so a
 *      write (POST/PUT/PATCH/DELETE) against a denied thread is refused even when
 *      the raw id is passed, not the name.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sitePath } from "./paths";

/** Max bytes read for a threads file — a name/id map is tiny; anything larger is a mistake. */
const THREADS_MAX_BYTES = 256 * 1024;

/** Param keys that carry a thread identifier across the site catalogs. */
export const THREAD_PARAM_KEYS = ["threadId", "conversationId", "chatId"] as const;

const ThreadEntrySchema = z.object({
  id: z.string().min(1),
  post: z.enum(["allow", "deny"]).default("allow"),
  notes: z.string().optional(),
  watch: z.boolean().optional(),
});

export const ThreadsFileSchema = z.record(z.string(), ThreadEntrySchema);

export type ThreadEntry = z.infer<typeof ThreadEntrySchema>;
export type ThreadsFile = z.infer<typeof ThreadsFileSchema>;

/** One resolved row for `mcx site threads` / internal listing. */
export interface ThreadListing {
  name: string;
  id: string;
  post: "allow" | "deny";
  notes?: string;
  watch: boolean;
}

export function siteThreadsPath(site: string): string {
  return join(sitePath(site), "threads.yaml");
}

function siteThreadsJsonPath(site: string): string {
  return join(sitePath(site), "threads.json");
}

/**
 * Load and validate a site's threads map. Returns `{}` when no file exists.
 * A `.yaml` file wins over a `.json` file when both are present.
 *
 * @param readFile injectable reader (defaults to the real fs) — for tests
 */
export function loadThreads(site: string, readFile: (path: string) => string | null = defaultRead): ThreadsFile {
  const yamlPath = siteThreadsPath(site);
  const jsonPath = siteThreadsJsonPath(site);
  const yamlText = readFile(yamlPath);
  if (yamlText !== null) return parseThreadsText(yamlText, "yaml");
  const jsonText = readFile(jsonPath);
  if (jsonText !== null) return parseThreadsText(jsonText, "json");
  return {};
}

function defaultRead(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  if (Buffer.byteLength(text, "utf-8") > THREADS_MAX_BYTES) {
    throw new Error(`threads file too large (> ${THREADS_MAX_BYTES} bytes): ${path}`);
  }
  return text;
}

export function parseThreadsText(text: string, kind: "yaml" | "json"): ThreadsFile {
  const raw = kind === "yaml" ? Bun.YAML.parse(text) : JSON.parse(text);
  // An empty YAML document parses to null; treat as no threads.
  if (raw === null || raw === undefined) return {};
  return ThreadsFileSchema.parse(raw);
}

/** Resolve a name to its id; a value that is not a known name is returned unchanged (assumed a raw id). */
export function resolveThreadId(threads: ThreadsFile, nameOrId: string): string {
  const entry = threads[nameOrId];
  return entry ? entry.id : nameOrId;
}

/** The configured name for a thread id, when one is declared. */
export function nameForThreadId(threads: ThreadsFile, threadId: string): string | undefined {
  for (const [name, entry] of Object.entries(threads)) {
    if (entry.id === threadId) return name;
  }
  return undefined;
}

/** The post policy for a resolved thread id. Unknown ids default to "allow". */
export function postPolicyForThreadId(threads: ThreadsFile, threadId: string): "allow" | "deny" {
  for (const entry of Object.values(threads)) {
    if (entry.id === threadId) return entry.post;
  }
  return "allow";
}

/** Sorted listing rows for a site. */
export function listThreads(threads: ThreadsFile): ThreadListing[] {
  return Object.entries(threads)
    .map(([name, entry]) => ({
      name,
      id: entry.id,
      post: entry.post,
      ...(entry.notes ? { notes: entry.notes } : {}),
      watch: entry.watch === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Thread ids marked `watch: true` — the boot auto-start set. */
export function watchedThreadIds(threads: ThreadsFile): string[] {
  return Object.values(threads)
    .filter((e) => e.watch === true)
    .map((e) => e.id);
}

/** HTTP methods that mutate; the post policy applies to these. */
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;

export function isWriteMethod(method: string): boolean {
  return WRITE_METHOD.test(method);
}

/**
 * Resolve any thread-name value in `params` (under a {@link THREAD_PARAM_KEYS}
 * key) to its id, in place. A name used where a threadId is accepted resolves to
 * the configured id; a raw id passes through unchanged.
 */
export function resolveThreadParams(threads: ThreadsFile, params: Record<string, unknown>): void {
  for (const key of THREAD_PARAM_KEYS) {
    const raw = params[key];
    if (typeof raw === "string") params[key] = resolveThreadId(threads, raw);
  }
}

/**
 * The resolved thread id a write would target if that thread is `post: "deny"`,
 * else null. Enforced at the tool layer so passing the raw id cannot bypass the
 * policy. `params` must already be resolved (see {@link resolveThreadParams}).
 */
export function deniedWriteThread(
  threads: ThreadsFile,
  params: Record<string, unknown>,
  method: string,
): string | null {
  if (!isWriteMethod(method)) return null;
  for (const key of THREAD_PARAM_KEYS) {
    const id = params[key];
    if (typeof id === "string" && postPolicyForThreadId(threads, id) === "deny") return id;
  }
  return null;
}
