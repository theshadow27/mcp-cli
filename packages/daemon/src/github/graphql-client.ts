/**
 * GitHub GraphQL client for fetching PR status.
 *
 * Uses aliased per-PR queries in a single GraphQL request to fetch only
 * tracked PRs. Auth via `gh auth token` with automatic refresh on 401.
 *
 * Phase 2a of #1049.
 */

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
}

export interface Review {
  state: string;
  author: string;
}

export interface PRStatus {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  ciState: string | null;
  ciChecks: CiCheck[];
  reviews: Review[];
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
      commits(last: 1) {
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
    }`,
  );

  return `query TrackedPRs($owner: String!, $repo: String!) {
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
}

interface RawReview {
  state?: string;
  author?: { login?: string } | null;
}

interface RawPR {
  number?: number;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  commits?: {
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
    }));

  const reviews: Review[] = (raw.reviews?.nodes ?? [])
    .filter((r): r is RawReview & { state: string } => !!r.state)
    .map((r) => ({
      state: r.state,
      author: r.author?.login ?? "unknown",
    }));

  return {
    number: raw.number ?? 0,
    state: (raw.state as PRStatus["state"]) ?? "OPEN",
    isDraft: raw.isDraft ?? false,
    mergeable: (raw.mergeable as PRStatus["mergeable"]) ?? "UNKNOWN",
    ciState: rollup?.state ?? null,
    ciChecks,
    reviews,
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
}

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

  const json: { data?: { repository?: Record<string, RawPR> }; errors?: Array<{ message: string }> } =
    await resp.json();

  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
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

async function doGraphQL(
  doFetch: FetchFn,
  token: string,
  query: string,
  variables: Record<string, string>,
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
