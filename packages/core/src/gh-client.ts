/**
 * First-class GitHub API client for alias scripts and phase handlers.
 *
 * Bun-native fetch()-based client providing typed, granular access to
 * GitHub's REST and GraphQL APIs. Eliminates shell-out wrappers and
 * provides auto-pagination, retry/backoff, and typed errors.
 *
 * Phase 1 of #2023 — direct api.github.com calls. Phase 2 (#1964)
 * adds daemon-backed caching.
 */

import type { Logger } from "./logger";
import { spawnCapture } from "./subprocess";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const MAX_PAGES = 20;
const INITIAL_BACKOFF_MS = 500;

// ── Typed errors ──

export class GhAuthError extends Error {
  override name = "GhAuthError" as const;
}

export class GhRateLimitError extends Error {
  override name = "GhRateLimitError" as const;
  resetAt: Date | null;
  constructor(message: string, resetAt?: Date) {
    super(message);
    this.resetAt = resetAt ?? null;
  }
}

export class GhNotFoundError extends Error {
  override name = "GhNotFoundError" as const;
}

export class GhValidationError extends Error {
  override name = "GhValidationError" as const;
  errors: unknown[];
  constructor(message: string, errors?: unknown[]) {
    super(message);
    this.errors = errors ?? [];
  }
}

export class GhServerError extends Error {
  override name = "GhServerError" as const;
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class GhPageCapError extends Error {
  override name = "GhPageCapError" as const;
  itemCount: number;
  path: string;
  constructor(message: string, itemCount: number, path = "") {
    super(message);
    this.itemCount = itemCount;
    this.path = path;
  }
}

// ── Response types ──

export interface GqlConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export interface GhPrBody {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  labels: string[];
  mergeable: boolean | null;
  mergeable_state: string;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface GhComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface GhInlineComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id: number | null;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface GhReview {
  id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  user: string;
  submitted_at: string;
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GhChecksResult {
  total_count: number;
  check_runs: GhCheckRun[];
  /** Legacy commit statuses, mapped to check-run shape for uniform filtering. */
  commit_statuses: GhCheckRun[];
}

export interface GhPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GhIssueBody {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
}

export interface GhLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GhSearchResult {
  total_count: number;
  items: Array<{
    number: number;
    title: string;
    state: string;
    labels: string[];
    pull_request?: { url: string };
  }>;
}

export interface GhRateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  used: number;
}

export interface GhAllCommentSurfaces {
  bodyComments: GhComment[];
  inlineComments: GhInlineComment[];
  reviews: GhReview[];
  issueComments: GhComment[];
  unrepliedTopLevelCount: number;
  byAuthor: Record<string, Array<GhComment | GhInlineComment | GhReview>>;
  substantiveByAuthor: Record<string, Array<GhComment | GhInlineComment | GhReview>>;
}

// ── Edit options ──

export interface GhPrEditOptions {
  title?: string;
  body?: string;
  // labels is intentionally absent: PATCH /pulls/{n} does not accept labels.
  // Use addLabels / removeLabels which route through the issues endpoint.
  addLabels?: string[];
  removeLabels?: string[];
}

export interface GhIssueEditOptions {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
}

export interface GhMergeOptions {
  method?: "merge" | "squash" | "rebase";
  auto?: boolean;
  deleteBranch?: boolean;
}

export interface GhReviewThread {
  id: string;
  isResolved: boolean;
  comments: Array<{ author: string; body: string }>;
}

// ── Auth ──

let tokenCache: string | null = null;

async function resolveToken(opts?: { getToken?: () => Promise<string> }): Promise<string> {
  if (opts?.getToken) return opts.getToken();
  if (tokenCache) return tokenCache;

  if (process.env.GH_TOKEN) {
    tokenCache = process.env.GH_TOKEN;
    return tokenCache;
  }
  if (process.env.GITHUB_TOKEN) {
    tokenCache = process.env.GITHUB_TOKEN;
    return tokenCache;
  }

  const token = await execGhAuthToken();
  tokenCache = token;
  return token;
}

function clearTokenCache(): void {
  tokenCache = null;
}

async function execGhAuthToken(): Promise<string> {
  const result = await spawnCapture("gh", ["auth", "token"]);
  if (!result.ok) {
    if (result.exitCode === null) {
      throw new GhAuthError("failed to spawn gh (not found on PATH?). Install GitHub CLI or set GH_TOKEN.");
    }
    throw new GhAuthError(
      `gh auth token failed (exit ${result.exitCode}): ${result.stderr.trim()}. Run \`gh auth login\` or set GH_TOKEN.`,
    );
  }
  return result.stdout.trim();
}

// ── Repo detection ──

export interface GhRepoInfo {
  owner: string;
  repo: string;
}

async function detectRepoFromGit(repoRoot: string): Promise<GhRepoInfo> {
  const result = await spawnCapture("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  if (!result.ok) {
    throw new Error(`Failed to detect GitHub repo from git remote in ${repoRoot}`);
  }
  return parseGitRemoteUrl(result.stdout.trim());
}

export function parseGitRemoteUrl(url: string): GhRepoInfo {
  const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`);
}

// ── HTTP layer ──

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "mcp-cli/gh-client",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function classifyResponse(resp: Response, body: string, logger?: Logger): never {
  if (resp.status === 401) {
    clearTokenCache();
    throw new GhAuthError(`GitHub API authentication failed (401): ${body}`);
  }
  if (resp.status === 403) {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const resetHeader = resp.headers.get("x-ratelimit-reset");
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : undefined;
      throw new GhRateLimitError(
        `GitHub API rate limit exhausted, resets at ${resetAt?.toISOString() ?? "unknown"}`,
        resetAt,
      );
    }
    throw new GhAuthError(`GitHub API forbidden (403): ${body}`);
  }
  if (resp.status === 404) {
    throw new GhNotFoundError(`GitHub API resource not found (404): ${body}`);
  }
  if (resp.status === 422) {
    let errors: unknown[] = [];
    try {
      const parsed = JSON.parse(body);
      errors = parsed.errors ?? [];
    } catch (parseErr) {
      logger?.warn("gh-client: failed to parse 422 response body", { err: parseErr, body: body.slice(0, 500) });
    }
    throw new GhValidationError(`GitHub API validation error (422): ${body}`, errors);
  }
  if (resp.status >= 500) {
    throw new GhServerError(`GitHub API server error (${resp.status}): ${body}`, resp.status);
  }
  throw new Error(`GitHub API unexpected error (${resp.status}): ${body}`);
}

interface RequestOptions {
  token: string;
  fetchFn: FetchFn;
  getToken?: () => Promise<string>;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  logger?: Logger;
}

async function ghRequest(path: string, opts: RequestOptions): Promise<Response> {
  const url = path.startsWith("https://") ? path : `${GITHUB_API_BASE}${path}`;
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: makeHeaders(opts.token),
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = INITIAL_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, backoff));
    }
    // Fresh signal per attempt so a timeout on attempt N doesn't abort attempt N+1.
    // If the caller supplied their own signal, honour it as-is (they manage its lifetime).
    init.signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await opts.fetchFn(url, init);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (resp.status === 401 && attempt === 0) {
      clearTokenCache();
      opts.token = await resolveToken({ getToken: opts.getToken });
      (init.headers as Record<string, string>).Authorization = `bearer ${opts.token}`;
      const body = await resp.text().catch(() => "");
      lastError = new GhAuthError(`GitHub API authentication failed (401): ${body}`);
      continue;
    }

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter && attempt < MAX_RETRIES) {
        const delaySec = Number.parseInt(retryAfter, 10);
        if (Number.isFinite(delaySec) && delaySec <= 120) {
          await new Promise((r) => setTimeout(r, delaySec * 1000));
          continue;
        }
      }
      const resetHeader = resp.headers.get("x-ratelimit-reset");
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : undefined;
      throw new GhRateLimitError("GitHub API rate limited (429)", resetAt);
    }

    if (resp.status >= 500 && attempt < MAX_RETRIES) {
      const body = await resp.text().catch(() => "");
      lastError = new GhServerError(`GitHub API server error (${resp.status}): ${body}`, resp.status);
      continue;
    }

    return resp;
  }

  throw lastError ?? new Error("GitHub API request failed after retries");
}

async function ghJson<T>(path: string, opts: RequestOptions): Promise<T> {
  const resp = await ghRequest(path, opts);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    classifyResponse(resp, body, opts.logger);
  }
  return resp.json();
}

async function ghVoid(path: string, opts: RequestOptions): Promise<void> {
  const resp = await ghRequest(path, opts);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    classifyResponse(resp, body, opts.logger);
  }
}

function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

async function ghPaginated<T>(path: string, opts: RequestOptions & { page?: number; per_page?: number }): Promise<T[]> {
  if (opts.page !== undefined) {
    const sep = path.includes("?") ? "&" : "?";
    const paginatedPath = `${path}${sep}page=${opts.page}&per_page=${opts.per_page ?? 100}`;
    return ghJson<T[]>(paginatedPath, opts);
  }

  const allItems: T[] = [];
  let url: string | null = path.includes("per_page=") ? path : `${path}${path.includes("?") ? "&" : "?"}per_page=100`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const fullUrl = url.startsWith("https://") ? url : `${GITHUB_API_BASE}${url}`;
    const resp = await ghRequest(fullUrl, opts);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      classifyResponse(resp, body, opts.logger);
    }
    const items: T[] = await resp.json();
    allItems.push(...items);
    url = parseNextUrl(resp.headers.get("link"));
    if (page === MAX_PAGES - 1 && url !== null) {
      throw new GhPageCapError(
        `ghPaginated: hit MAX_PAGES (${MAX_PAGES}) at ${path} but more pages remain — result is truncated. Increase MAX_PAGES or use a more specific query.`,
        allItems.length,
        path,
      );
    }
  }
  return allItems;
}

// ── Raw response shapes (GitHub API) ──

interface RawPr {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  labels: Array<{ name: string }>;
  mergeable: boolean | null;
  mergeable_state: string;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface RawComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface RawInlineComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id: number | null;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface RawReview {
  id: number;
  state: string;
  body: string;
  user: { login: string };
  submitted_at: string;
}

interface RawCommitStatus {
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string | null;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

// ── Helpers ──

function normalizeConclusion(conclusion: string | null): string | null {
  return conclusion !== null ? conclusion.toUpperCase() : null;
}

// ── Mappers ──

function mapPr(raw: RawPr): GhPrBody {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state as GhPrBody["state"],
    merged: raw.merged ?? false,
    draft: raw.draft,
    labels: raw.labels.map((l) => l.name),
    mergeable: raw.mergeable,
    mergeable_state: raw.mergeable_state,
    merge_commit_sha: raw.merge_commit_sha,
    head: raw.head,
    base: raw.base,
    user: raw.user.login,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    merged_at: raw.merged_at,
  };
}

function mapComment(raw: RawComment): GhComment {
  return {
    id: raw.id,
    body: raw.body,
    user: raw.user.login,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function mapInlineComment(raw: RawInlineComment): GhInlineComment {
  return {
    id: raw.id,
    body: raw.body,
    path: raw.path,
    line: raw.line,
    original_line: raw.original_line,
    in_reply_to_id: raw.in_reply_to_id,
    user: raw.user.login,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function mapReview(raw: RawReview): GhReview {
  return {
    id: raw.id,
    state: raw.state as GhReview["state"],
    body: raw.body,
    user: raw.user.login,
    submitted_at: raw.submitted_at,
  };
}

function mapIssue(raw: RawIssue): GhIssueBody {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state as GhIssueBody["state"],
    labels: raw.labels.map((l) => l.name),
    user: raw.user.login,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

// ── PR Handle ──

export class PrHandle {
  private readonly o: string;
  private readonly r: string;
  private readonly n: number;
  private readonly reqOpts: () => RequestOptions;

  constructor(owner: string, repo: string, prNumber: number, reqOpts: () => RequestOptions) {
    this.o = owner;
    this.r = repo;
    this.n = prNumber;
    this.reqOpts = reqOpts;
  }

  async body(): Promise<GhPrBody> {
    const raw = await ghJson<RawPr>(`/repos/${this.o}/${this.r}/pulls/${this.n}`, this.reqOpts());
    return mapPr(raw);
  }

  async bodyComments(): Promise<GhComment[]> {
    const raw = await ghPaginated<RawComment>(`/repos/${this.o}/${this.r}/issues/${this.n}/comments`, this.reqOpts());
    return raw.map(mapComment);
  }

  async inlineComments(): Promise<GhInlineComment[]> {
    const raw = await ghPaginated<RawInlineComment>(
      `/repos/${this.o}/${this.r}/pulls/${this.n}/comments`,
      this.reqOpts(),
    );
    return raw.map(mapInlineComment);
  }

  async reviews(): Promise<GhReview[]> {
    const raw = await ghPaginated<RawReview>(`/repos/${this.o}/${this.r}/pulls/${this.n}/reviews`, this.reqOpts());
    return raw.map(mapReview);
  }

  async checks(): Promise<GhChecksResult> {
    const pr = await this.body();
    const sha = pr.head.sha;
    const [checkRunsRaw, statusesRaw] = await Promise.all([
      ghJson<{ total_count: number; check_runs: GhCheckRun[] }>(
        `/repos/${this.o}/${this.r}/commits/${sha}/check-runs`,
        this.reqOpts(),
      ),
      ghPaginated<RawCommitStatus>(`/repos/${this.o}/${this.r}/commits/${sha}/statuses`, this.reqOpts()),
    ]);

    // Deduplicate by context: GitHub returns statuses in reverse-chronological
    // order, so the first occurrence per context is the most recent.
    const seen = new Set<string>();
    const dedupedStatuses: GhCheckRun[] = [];
    for (const s of statusesRaw) {
      if (seen.has(s.context)) continue;
      seen.add(s.context);
      dedupedStatuses.push({
        id: 0,
        name: s.context,
        status: "completed",
        conclusion: s.state === "success" ? "SUCCESS" : s.state === "pending" ? null : "FAILURE",
      });
    }

    return {
      total_count: checkRunsRaw.total_count,
      check_runs: checkRunsRaw.check_runs.map((cr) => ({ ...cr, conclusion: normalizeConclusion(cr.conclusion) })),
      commit_statuses: dedupedStatuses,
    };
  }

  async files(): Promise<GhPrFile[]> {
    return ghPaginated<GhPrFile>(`/repos/${this.o}/${this.r}/pulls/${this.n}/files`, this.reqOpts());
  }

  async edit(opts: GhPrEditOptions): Promise<void> {
    const patchBody: Record<string, unknown> = {};
    if (opts.title !== undefined) patchBody.title = opts.title;
    if (opts.body !== undefined) patchBody.body = opts.body;
    if (Object.keys(patchBody).length > 0) {
      await ghVoid(`/repos/${this.o}/${this.r}/pulls/${this.n}`, {
        ...this.reqOpts(),
        method: "PATCH",
        body: patchBody,
      });
    }

    if (opts.addLabels?.length) {
      await ghVoid(`/repos/${this.o}/${this.r}/issues/${this.n}/labels`, {
        ...this.reqOpts(),
        method: "POST",
        body: { labels: opts.addLabels },
      });
    }

    if (opts.removeLabels?.length) {
      for (const label of opts.removeLabels) {
        try {
          await ghVoid(`/repos/${this.o}/${this.r}/issues/${this.n}/labels/${encodeURIComponent(label)}`, {
            ...this.reqOpts(),
            method: "DELETE",
          });
        } catch (err) {
          if (!(err instanceof GhNotFoundError)) throw err;
        }
      }
    }
  }

  async merge(opts?: GhMergeOptions): Promise<void> {
    const method = opts?.method ?? "squash";

    if (opts?.auto) {
      const mutationId = `auto-merge-${this.n}-${Date.now()}`;
      await ghJson<unknown>(GITHUB_GRAPHQL_URL, {
        ...this.reqOpts(),
        method: "POST",
        body: {
          query: `mutation($input: EnablePullRequestAutoMergeInput!) {
            enablePullRequestAutoMerge(input: $input) {
              clientMutationId
            }
          }`,
          variables: {
            input: {
              pullRequestId: await this.nodeId(),
              mergeMethod: method.toUpperCase(),
              clientMutationId: mutationId,
            },
          },
        },
      });
      return;
    }

    await ghVoid(`/repos/${this.o}/${this.r}/pulls/${this.n}/merge`, {
      ...this.reqOpts(),
      method: "PUT",
      body: { merge_method: method },
    });

    if (opts?.deleteBranch) {
      const pr = await this.body();
      try {
        await ghVoid(`/repos/${this.o}/${this.r}/git/refs/heads/${pr.head.ref}`, {
          ...this.reqOpts(),
          method: "DELETE",
        });
      } catch {
        // best-effort branch deletion
      }
    }
  }

  async comment(body: string): Promise<GhComment> {
    const raw = await ghJson<RawComment>(`/repos/${this.o}/${this.r}/issues/${this.n}/comments`, {
      ...this.reqOpts(),
      method: "POST",
      body: { body },
    });
    return mapComment(raw);
  }

  async replyToInlineThread(commentId: number, body: string): Promise<GhInlineComment> {
    const raw = await ghJson<RawInlineComment>(`/repos/${this.o}/${this.r}/pulls/${this.n}/comments`, {
      ...this.reqOpts(),
      method: "POST",
      body: { body, in_reply_to: commentId },
    });
    return mapInlineComment(raw);
  }

  async requestReview(reviewer: string): Promise<void> {
    await ghVoid(`/repos/${this.o}/${this.r}/pulls/${this.n}/requested_reviewers`, {
      ...this.reqOpts(),
      method: "POST",
      body: { reviewers: [reviewer] },
    });
  }

  async allCommentSurfaces(opts?: { linkedIssue?: number }): Promise<GhAllCommentSurfaces> {
    const fetchIssueComments = opts?.linkedIssue
      ? () =>
          ghPaginated<RawComment>(
            `/repos/${this.o}/${this.r}/issues/${opts.linkedIssue}/comments`,
            this.reqOpts(),
          ).then((raw) => raw.map(mapComment))
      : () => Promise.resolve([] as GhComment[]);

    const [bodyComments, inlineComments, reviews, issueComments] = await Promise.all([
      this.bodyComments(),
      this.inlineComments(),
      this.reviews(),
      fetchIssueComments(),
    ]);

    const unrepliedTopLevelCount = inlineComments.filter((c) => c.in_reply_to_id === null).length;

    const byAuthor: Record<string, Array<GhComment | GhInlineComment | GhReview>> = {};
    const substantiveByAuthor: Record<string, Array<GhComment | GhInlineComment | GhReview>> = {};
    const botPattern = /\[bot\]$/;

    for (const c of [...bodyComments, ...inlineComments, ...reviews, ...issueComments]) {
      const author = c.user;
      if (!byAuthor[author]) byAuthor[author] = [];
      byAuthor[author].push(c);
      if (!botPattern.test(author)) {
        if (!substantiveByAuthor[author]) substantiveByAuthor[author] = [];
        substantiveByAuthor[author].push(c);
      }
    }

    return {
      bodyComments,
      inlineComments,
      reviews,
      issueComments,
      unrepliedTopLevelCount,
      byAuthor,
      substantiveByAuthor,
    };
  }

  async reviewThreads(): Promise<GhReviewThread[]> {
    type GqlResponse = {
      data?: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean };
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: { nodes: Array<{ author: { login: string }; body: string }> };
              }>;
            };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };
    const json = await ghJson<GqlResponse>(GITHUB_GRAPHQL_URL, {
      ...this.reqOpts(),
      method: "POST",
      body: {
        // dotw-ignore gql-query-paginates: comments(first:1) is intentionally root-only; per-thread reply truncation is not a concern for this summary — full threads are handled by getPrThreadSnapshot
        query: `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes {
                      author { login }
                      body
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { owner: this.o, name: this.r, number: this.n },
      },
    });
    if (json.errors?.length) {
      throw new GhValidationError(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`, json.errors);
    }
    const threads = json.data?.repository?.pullRequest?.reviewThreads;
    if (threads?.pageInfo?.hasNextPage) {
      this.reqOpts().logger?.warn("reviewThreads: results truncated at 100 — more threads exist", {
        pr: this.n,
      });
    }
    return (threads?.nodes ?? []).map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      comments: t.comments?.nodes?.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body })) ?? [],
    }));
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    type GqlResponse = {
      data?: unknown;
      errors?: Array<{ message: string }>;
    };
    const json = await ghJson<GqlResponse>(GITHUB_GRAPHQL_URL, {
      ...this.reqOpts(),
      method: "POST",
      body: {
        query: `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        variables: { threadId },
      },
    });
    if (json.errors?.length) {
      throw new GhValidationError(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`, json.errors);
    }
  }

  private async nodeId(): Promise<string> {
    const raw = await ghJson<{ node_id: string }>(`/repos/${this.o}/${this.r}/pulls/${this.n}`, this.reqOpts());
    return raw.node_id;
  }
}

// ── Issue Handle ──

export class IssueHandle {
  private readonly o: string;
  private readonly r: string;
  private readonly n: number;
  private readonly reqOpts: () => RequestOptions;

  constructor(owner: string, repo: string, issueNumber: number, reqOpts: () => RequestOptions) {
    this.o = owner;
    this.r = repo;
    this.n = issueNumber;
    this.reqOpts = reqOpts;
  }

  async body(): Promise<GhIssueBody> {
    const raw = await ghJson<RawIssue>(`/repos/${this.o}/${this.r}/issues/${this.n}`, this.reqOpts());
    return mapIssue(raw);
  }

  async comments(): Promise<GhComment[]> {
    const raw = await ghPaginated<RawComment>(`/repos/${this.o}/${this.r}/issues/${this.n}/comments`, this.reqOpts());
    return raw.map(mapComment);
  }

  async comment(body: string): Promise<GhComment> {
    const raw = await ghJson<RawComment>(`/repos/${this.o}/${this.r}/issues/${this.n}/comments`, {
      ...this.reqOpts(),
      method: "POST",
      body: { body },
    });
    return mapComment(raw);
  }

  async edit(opts: GhIssueEditOptions): Promise<void> {
    const patchBody: Record<string, unknown> = {};
    if (opts.title !== undefined) patchBody.title = opts.title;
    if (opts.body !== undefined) patchBody.body = opts.body;
    if (opts.state !== undefined) patchBody.state = opts.state;
    if (opts.labels !== undefined) patchBody.labels = opts.labels;
    if (Object.keys(patchBody).length === 0) return;
    await ghVoid(`/repos/${this.o}/${this.r}/issues/${this.n}`, {
      ...this.reqOpts(),
      method: "PATCH",
      body: patchBody,
    });
  }
}

// ── Repo Handle ──

class RepoHandle {
  private readonly o: string;
  private readonly r: string;
  private readonly reqOpts: () => RequestOptions;

  constructor(owner: string, repo: string, reqOpts: () => RequestOptions) {
    this.o = owner;
    this.r = repo;
    this.reqOpts = reqOpts;
  }

  async labels(): Promise<GhLabel[]> {
    return ghPaginated<GhLabel>(`/repos/${this.o}/${this.r}/labels`, this.reqOpts());
  }

  async searchIssues(opts: { query: string; sort?: string; order?: "asc" | "desc" }): Promise<GhSearchResult> {
    const q = encodeURIComponent(`repo:${this.o}/${this.r} ${opts.query}`);
    const sort = opts.sort ? `&sort=${opts.sort}` : "";
    const order = opts.order ? `&order=${opts.order}` : "";
    const raw = await ghJson<{
      total_count: number;
      items: Array<{
        number: number;
        title: string;
        state: string;
        labels: Array<{ name: string }>;
        pull_request?: { url: string };
      }>;
    }>(`/search/issues?q=${q}${sort}${order}`, this.reqOpts());
    return {
      total_count: raw.total_count,
      items: raw.items.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        labels: i.labels.map((l) => l.name),
        pull_request: i.pull_request,
      })),
    };
  }
}

// ── GhClient ──

export interface GhClientOptions {
  repoRoot: string;
  getToken?: () => Promise<string>;
  fetch?: FetchFn;
  owner?: string;
  repo?: string;
  logger?: Logger;
}

export class GhClient {
  private readonly repoRoot: string;
  private readonly getTokenFn: (() => Promise<string>) | undefined;
  private readonly fetchFn: FetchFn;
  private readonly logger: Logger | undefined;
  private resolvedRepo: GhRepoInfo | null;
  private cachedReqOpts: RequestOptions | null = null;

  constructor(opts: GhClientOptions) {
    this.repoRoot = opts.repoRoot;
    this.getTokenFn = opts.getToken;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.logger = opts.logger;
    this.resolvedRepo = opts.owner && opts.repo ? { owner: opts.owner, repo: opts.repo } : null;
  }

  private async ensureRepo(): Promise<GhRepoInfo> {
    if (!this.resolvedRepo) {
      this.resolvedRepo = await detectRepoFromGit(this.repoRoot);
    }
    return this.resolvedRepo;
  }

  private async makeReqOpts(): Promise<RequestOptions> {
    if (this.cachedReqOpts) return this.cachedReqOpts;
    const token = await resolveToken({ getToken: this.getTokenFn });
    this.cachedReqOpts = { token, fetchFn: this.fetchFn, getToken: this.getTokenFn, logger: this.logger };
    return this.cachedReqOpts;
  }

  /**
   * Eagerly resolve the GitHub token and repo, throwing immediately if either
   * fails. Call this at phase-script setup time to surface auth/repo errors
   * before building handles — useful when a phase script constructs multiple
   * handles and would otherwise only fail on the third `.body()` call.
   *
   * Safe to call multiple times; resolution is cached after the first call.
   */
  async validate(): Promise<void> {
    await this.ensureRepo();
    await this.makeReqOpts();
  }

  pr(prNumber: number): PrHandle {
    const self = this;
    let cachedOpts: RequestOptions | null = null;
    const reqOpts = () => {
      if (cachedOpts) return cachedOpts;
      throw new Error("PrHandle methods must be called with await — reqOpts not yet resolved");
    };

    const makeLazy = (): PrHandle => {
      const handle = new PrHandle("", "", prNumber, reqOpts);
      const proxy = new Proxy(handle, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && typeof (target as unknown as Record<string, unknown>)[prop] === "function") {
            return async (...args: unknown[]) => {
              const repo = await self.ensureRepo();
              cachedOpts = await self.makeReqOpts();
              const opts = cachedOpts as RequestOptions;
              const realHandle = new PrHandle(repo.owner, repo.repo, prNumber, () => opts);
              return (realHandle as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return proxy;
    };
    return makeLazy();
  }

  issue(issueNumber: number): IssueHandle {
    const self = this;
    let cachedOpts: RequestOptions | null = null;

    const handle = new IssueHandle("", "", issueNumber, () => {
      if (cachedOpts) return cachedOpts;
      throw new Error("IssueHandle methods must be called with await");
    });
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && typeof (target as unknown as Record<string, unknown>)[prop] === "function") {
          return async (...args: unknown[]) => {
            const repo = await self.ensureRepo();
            cachedOpts = await self.makeReqOpts();
            const opts = cachedOpts as RequestOptions;
            const realHandle = new IssueHandle(repo.owner, repo.repo, issueNumber, () => opts);
            return (realHandle as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  repo(): RepoHandle {
    const self = this;
    let cachedOpts: RequestOptions | null = null;

    const handle = new RepoHandle("", "", () => {
      if (cachedOpts) return cachedOpts;
      throw new Error("RepoHandle methods must be called with await");
    });
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && typeof (target as unknown as Record<string, unknown>)[prop] === "function") {
          return async (...args: unknown[]) => {
            const repo = await self.ensureRepo();
            cachedOpts = await self.makeReqOpts();
            const opts = cachedOpts as RequestOptions;
            const realHandle = new RepoHandle(repo.owner, repo.repo, () => opts);
            return (realHandle as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const opts = await this.makeReqOpts();
    const resp = await ghRequest(GITHUB_GRAPHQL_URL, {
      ...opts,
      method: "POST",
      body: { query, variables: variables ?? {} },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      classifyResponse(resp, body, opts.logger);
    }
    const json: { data?: T; errors?: Array<{ message: string }> } = await resp.json();
    if (json.errors?.length) {
      throw new GhValidationError(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`, json.errors);
    }
    return json.data as T;
  }

  async paginateGql<T>(
    query: string,
    variables: Omit<Record<string, unknown>, "after">,
    selectConnection: (data: unknown) => GqlConnection<T>,
  ): Promise<T[]> {
    const allNodes: T[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      // Spread variables first so our cursor always wins; the type already
      // forbids `after` in the caller, but the strip guards against runtime drift.
      const { after: _ignored, ...baseVars } = variables as Record<string, unknown>;
      const vars = { ...baseVars, ...(cursor ? { after: cursor } : {}) };
      const data = await this.graphql(query, vars);
      const connection = selectConnection(data);
      allNodes.push(...connection.nodes);

      if (!connection.pageInfo.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
      if (!cursor) {
        throw new GhValidationError(
          "paginateGql: hasNextPage is true but endCursor is null — cannot continue pagination",
          [],
        );
      }

      if (page === MAX_PAGES - 1) {
        throw new GhPageCapError(
          `paginateGql: hit MAX_PAGES (${MAX_PAGES}) but more pages remain — result is truncated`,
          allNodes.length,
          "graphql",
        );
      }
    }
    return allNodes;
  }

  async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const opts = await this.makeReqOpts();
    return ghJson<T>(path, { ...opts, method, body });
  }

  async rateLimit(): Promise<GhRateLimitInfo> {
    const opts = await this.makeReqOpts();
    const raw = await ghJson<{ rate: { limit: number; remaining: number; reset: number; used: number } }>(
      "/rate_limit",
      opts,
    );
    return {
      limit: raw.rate.limit,
      remaining: raw.rate.remaining,
      reset: new Date(raw.rate.reset * 1000),
      used: raw.rate.used,
    };
  }
}

// ── Factory ──

export function createGhClient(opts: GhClientOptions): GhClient {
  return new GhClient(opts);
}

// re-export for testing
export { resolveToken as _resolveToken, clearTokenCache as _clearTokenCache };
