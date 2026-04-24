/**
 * GitHub GraphQL client for fetching PR status.
 *
 * Uses aliased per-PR queries in a single GraphQL request to fetch only
 * tracked PRs. Auth via `gh auth token` with automatic refresh on 401.
 *
 * Phase 2a of #1049.
 */

import type { MergeStateStatus } from "@mcp-cli/core";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_TIMEOUT_MS = 10_000;

// ---------- Types ----------

export interface RepoInfo {
  owner: string;
  repo: string;
}

export interface CiCheck {
  name: string;
  status: string;
  conclusion: string | null;
  checkSuiteId: number | null;
}

export interface Review {
  state: string;
  author: string;
}

export interface PRFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PRStatus {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: MergeStateStatus;
  autoMergeEnabled: boolean;
  updatedAt: string;
  ciState: string | null;
  ciChecks: CiCheck[];
  reviews: Review[];
  commitCount: number;
  headRefName: string;
  baseRefName: string;
  /** SHA of the HEAD commit on the PR branch — use for push detection (survives force-push / rebase). */
  headRefOid: string;
  mergeCommitOid: string | null;
  files: PRFile[];
  /** True when the PR touches >100 files and the files list was truncated. srcChurn is understated. */
  filesTruncated: boolean;
}

// ---------- GraphQL query builder ----------

/**
 * Build a GraphQL query with aliased pullRequest fields, one per tracked PR.
 * This avoids fetching all PRs and filtering client-side.
 */
export function buildQuery(prNumbers: readonly number[]): string {
  const fragments = prNumbers.map(
    (n) => `
    pr${n}: pullRequest(number: ${n}) {
      number
      state
      isDraft
      mergeable
      headRefName
      baseRefName
      headRefOid
      mergeStateStatus
      autoMergeRequest { enabledAt }
      updatedAt
      commits(last: 1) {
        totalCount
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 50) {
                nodes {
                  ... on CheckRun {
                    name
                    conclusion
                    status
                    checkSuite { databaseId }
                  }
                }
              }
            }
          }
        }
      }
      reviews(last: 5) {
        nodes {
          state
          author { login }
        }
      }
      files(first: 100) {
        pageInfo {
          hasNextPage
        }
        nodes {
          path
          additions
          deletions
        }
      }
      mergeCommit {
        oid
      }
    }`,
  );

  return `query TrackedPRs($owner: String!, $repo: String!) {
  rateLimit {
    remaining
  }
  repository(owner: $owner, name: $repo) {
    ${fragments.join("\n    ")}
  }
}`;
}

// ---------- Response parsing ----------

interface RawCheckRun {
  name?: string;
  conclusion?: string | null;
  status?: string;
  checkSuite?: { databaseId?: number | null } | null;
}

interface RawReview {
  state?: string;
  author?: { login?: string } | null;
}

interface RawFile {
  path?: string;
  additions?: number;
  deletions?: number;
}

interface RawPR {
  number?: number;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  headRefName?: string;
  baseRefName?: string;
  headRefOid?: string;
  mergeStateStatus?: string;
  autoMergeRequest?: { enabledAt?: string } | null;
  updatedAt?: string;
  commits?: {
    totalCount?: number;
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          state?: string;
          contexts?: { nodes?: RawCheckRun[] };
        } | null;
      };
    }>;
  };
  reviews?: { nodes?: RawReview[] };
  files?: { pageInfo?: { hasNextPage?: boolean }; nodes?: RawFile[] };
  mergeCommit?: { oid?: string } | null;
}

function parsePR(raw: RawPR): PRStatus {
  const commit = raw.commits?.nodes?.[0]?.commit;
  const rollup = commit?.statusCheckRollup;

  const ciChecks: CiCheck[] = (rollup?.contexts?.nodes ?? [])
    .filter((n): n is RawCheckRun & { name: string } => !!n.name)
    .map((n) => ({
      name: n.name,
      status: n.status ?? "QUEUED",
      conclusion: n.conclusion ?? null,
      checkSuiteId: n.checkSuite?.databaseId ?? null,
    }));

  const reviews: Review[] = (raw.reviews?.nodes ?? [])
    .filter((r): r is RawReview & { state: string } => !!r.state)
    .map((r) => ({
      state: r.state,
      author: r.author?.login ?? "unknown",
    }));

  const files: PRFile[] = (raw.files?.nodes ?? [])
    .filter((f): f is RawFile & { path: string } => !!f.path)
    .map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }));

  return {
    number: raw.number ?? 0,
    state: (raw.state as PRStatus["state"]) ?? "OPEN",
    isDraft: raw.isDraft ?? false,
    mergeable: (raw.mergeable as PRStatus["mergeable"]) ?? "UNKNOWN",
    mergeStateStatus: (raw.mergeStateStatus as MergeStateStatus) ?? "UNKNOWN",
    autoMergeEnabled: raw.autoMergeRequest != null,
    updatedAt: raw.updatedAt ?? new Date(Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ciState: rollup?.state ?? null,
    ciChecks,
    reviews,
    commitCount: raw.commits?.totalCount ?? 0,
    headRefName: raw.headRefName ?? "",
    baseRefName: raw.baseRefName ?? "",
    headRefOid: raw.headRefOid ?? "",
    mergeCommitOid: raw.mergeCommit?.oid ?? null,
    files,
    filesTruncated: raw.files?.pageInfo?.hasNextPage ?? false,
  };
}

// ---------- Auth ----------

let cachedToken: string | null = null;

/** Get a GitHub token via `gh auth token`. Caches the result. */
export async function getGhToken(opts?: { exec?: typeof execGhAuthToken }): Promise<string> {
  if (cachedToken) return cachedToken;
  const exec = opts?.exec ?? execGhAuthToken;
  const token = await exec();
  cachedToken = token;
  return token;
}

/** Clear the cached token (used on 401 to force refresh). */
export function clearTokenCache(): void {
  cachedToken = null;
}

async function execGhAuthToken(): Promise<string> {
  const proc = Bun.spawn(["gh", "auth", "token"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`gh auth token failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  return stdout.trim();
}

// ---------- Repo detection ----------

/** Detect owner/repo from the git remote origin URL. */
export async function detectRepo(
  cwd?: string,
  opts?: { exec?: (args: string[], cwd?: string) => Promise<string> },
): Promise<RepoInfo> {
  const exec = opts?.exec ?? execGitRemote;
  const url = await exec(["git", "remote", "get-url", "origin"], cwd);
  return parseRemoteUrl(url.trim());
}

async function execGitRemote(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to get git remote origin URL");
  }
  return new Response(proc.stdout).text();
}

/** Parse a git remote URL into owner/repo. Supports HTTPS and SSH formats. */
export function parseRemoteUrl(url: string): RepoInfo {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`);
}

// ---------- Fetch ----------

/** A minimal fetch signature (avoids Bun's extended `typeof fetch` with `preconnect`). */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchPRsOptions {
  getToken?: () => Promise<string>;
  fetch?: FetchFn;
  /** Called to log warnings (e.g. low rate-limit). */
  warn?: (msg: string) => void;
}

const RATE_LIMIT_WARN_THRESHOLD = 500;

/**
 * Fetch status for tracked PRs in a single GraphQL request.
 * Retries once on 401 after refreshing the token.
 */
export async function fetchTrackedPRs(
  repo: RepoInfo,
  prNumbers: readonly number[],
  opts?: FetchPRsOptions,
): Promise<PRStatus[]> {
  if (prNumbers.length === 0) return [];

  const getToken = opts?.getToken ?? getGhToken;
  const doFetch: FetchFn = opts?.fetch ?? globalThis.fetch;
  const warn = opts?.warn;

  const query = buildQuery(prNumbers);
  const variables = { owner: repo.owner, repo: repo.repo };

  let token = await getToken();
  let resp = await doGraphQL(doFetch, token, query, variables);

  // Retry once on 401 (expired token)
  if (resp.status === 401) {
    clearTokenCache();
    token = await getToken();
    resp = await doGraphQL(doFetch, token, query, variables);
  }

  // Handle 403: rate limit exhaustion or token scope change
  if (resp.status === 403) {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    const resetHeader = resp.headers.get("x-ratelimit-reset");
    if (remaining === "0" && resetHeader) {
      const resetAt = new Date(Number(resetHeader) * 1000);
      throw new Error(`GitHub API rate limit exhausted, resets at ${resetAt.toISOString()}`);
    }
    // Scope change or other auth issue — clear token cache so next poll gets a fresh token
    clearTokenCache();
    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub API returned 403 (possible token scope change): ${body}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub GraphQL API returned ${resp.status}: ${body}`);
  }

  const json: {
    data?: { rateLimit?: { remaining?: number }; repository?: Record<string, RawPR> };
    errors?: Array<{ message: string }>;
  } = await resp.json();

  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  const remaining = json.data?.rateLimit?.remaining;
  if (warn && typeof remaining === "number" && remaining < RATE_LIMIT_WARN_THRESHOLD) {
    try {
      warn(`[mcpd] GitHub GraphQL rate limit low: ${remaining} requests remaining`);
    } catch {}
  }

  const repoData = json.data?.repository;
  if (!repoData) return [];

  const results: PRStatus[] = [];
  for (const num of prNumbers) {
    const raw = repoData[`pr${num}`];
    if (raw) results.push(parsePR(raw));
  }
  return results;
}

// ---------- Issue/PR resolution ----------

export interface ResolvedNumber {
  /** Whether the number is a pull request. */
  isPR: boolean;
  /** The PR number (same as input if isPR, or linked PR if issue). null if no PR found. */
  prNumber: number | null;
}

const RESOLVE_QUERY = `query ResolveNumber($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest { number }
      ... on Issue {
        timelineItems(itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT], first: 50) {
          nodes {
            __typename
            ... on ConnectedEvent {
              subject { __typename ... on PullRequest { number state } }
            }
            ... on CrossReferencedEvent {
              source { __typename ... on PullRequest { number state } }
            }
          }
        }
      }
    }
  }
}`;

interface RawTimelineNode {
  __typename?: string;
  subject?: { __typename?: string; number?: number; state?: string };
  source?: { __typename?: string; number?: number; state?: string };
}

interface RawIssueOrPR {
  __typename?: string;
  number?: number;
  timelineItems?: { nodes?: RawTimelineNode[] };
}

/**
 * Resolve a GitHub issue/PR number to determine if it's a PR or find a linked PR.
 * Returns { isPR: true, prNumber: N } if the number is a PR,
 * { isPR: false, prNumber: M } if it's an issue with a linked PR,
 * or { isPR: false, prNumber: null } if no PR is associated.
 */
export async function resolveNumber(repo: RepoInfo, number: number, opts?: FetchPRsOptions): Promise<ResolvedNumber> {
  const getToken = opts?.getToken ?? getGhToken;
  const doFetch: FetchFn = opts?.fetch ?? globalThis.fetch;

  const variables = { owner: repo.owner, repo: repo.repo, number };

  let token = await getToken();
  let resp = await doGraphQL(doFetch, token, RESOLVE_QUERY, variables);

  if (resp.status === 401) {
    clearTokenCache();
    token = await getToken();
    resp = await doGraphQL(doFetch, token, RESOLVE_QUERY, variables);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub GraphQL API returned ${resp.status}: ${body}`);
  }

  const json: { data?: { repository?: { issueOrPullRequest?: RawIssueOrPR } }; errors?: Array<{ message: string }> } =
    await resp.json();

  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  const node = json.data?.repository?.issueOrPullRequest;
  if (!node) return { isPR: false, prNumber: null };

  if (node.__typename === "PullRequest") {
    return { isPR: true, prNumber: node.number ?? number };
  }

  // It's an issue — collect all linked PRs from timeline, then pick the best one
  const timelineNodes = node.timelineItems?.nodes ?? [];
  const linkedPRs: Array<{ number: number; state: string }> = [];
  for (const tNode of timelineNodes) {
    if (tNode.__typename === "ConnectedEvent" && tNode.subject?.__typename === "PullRequest" && tNode.subject.number) {
      linkedPRs.push({ number: tNode.subject.number, state: tNode.subject.state ?? "UNKNOWN" });
    }
    if (
      tNode.__typename === "CrossReferencedEvent" &&
      tNode.source?.__typename === "PullRequest" &&
      tNode.source.number
    ) {
      linkedPRs.push({ number: tNode.source.number, state: tNode.source.state ?? "UNKNOWN" });
    }
  }

  if (linkedPRs.length === 0) return { isPR: false, prNumber: null };

  // Prefer open PRs over closed; among same-state, prefer highest number (most recent)
  const best = pickBestLinkedPR(linkedPRs);
  return { isPR: false, prNumber: best };
}

// ---------- PR selection ----------

/**
 * Pick the best linked PR: prefer OPEN over non-OPEN, then highest number (most recent).
 * Exported for testing.
 */
export function pickBestLinkedPR(prs: ReadonlyArray<{ number: number; state: string }>): number {
  const open = prs.filter((p) => p.state === "OPEN");
  const candidates = open.length > 0 ? open : prs;
  return candidates.reduce((best, p) => (p.number > best.number ? p : best)).number;
}

// ---------- Fetch (internal) ----------

async function doGraphQL(
  doFetch: FetchFn,
  token: string,
  query: string,
  variables: Record<string, string | number>,
): Promise<Response> {
  return doFetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "mcp-cli/1.0",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
