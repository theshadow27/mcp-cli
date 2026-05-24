import type { IpcMethod, PrCommentEntry, PrReviewEntry, PrThread, PrThreadSnapshot } from "@mcp-cli/core";
import { GetPrThreadSnapshotParamsSchema, createGhClient, parseGitRemoteUrl, spawnCapture } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";

// ── Bot-noise filter ──

const CODERABBIT_USER = "coderabbitai[bot]";
const ROBOBUN_WATERMARK = /<!-- generated-comment/;

export { COPILOT_USERS } from "@mcp-cli/core";

export function isBotNoise(entry: { user: string; body: string }): boolean {
  if (entry.user === CODERABBIT_USER) return true;
  if (ROBOBUN_WATERMARK.test(entry.body)) return true;
  return false;
}

// ── GraphQL query ──

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              databaseId
              body
              author { login }
              path
              line
            }
          }
        }
      }
      reviews(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          databaseId
          body
          state
          author { login }
        }
      }
      comments(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          databaseId
          body
          author { login }
        }
      }
      headRefOid
      pushedAt
    }
  }
}
`;

// ── GraphQL response types ──

interface GqlThreadComment {
  databaseId: number;
  body: string;
  author: { login: string } | null;
  path: string | null;
  line: number | null;
}

interface GqlThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: { pageInfo: { hasNextPage: boolean }; nodes: GqlThreadComment[] };
}

interface GqlReview {
  databaseId: number;
  body: string;
  state: string;
  author: { login: string } | null;
}

interface GqlComment {
  databaseId: number;
  body: string;
  author: { login: string } | null;
}

interface GqlPageInfo {
  hasNextPage: boolean;
}

interface GqlResponse {
  repository: {
    pullRequest: {
      reviewThreads: { pageInfo: GqlPageInfo; nodes: GqlThread[] };
      reviews: { pageInfo: GqlPageInfo; nodes: GqlReview[] };
      comments: { pageInfo: GqlPageInfo; nodes: GqlComment[] };
      headRefOid: string;
      pushedAt: string | null;
    };
  };
}

// ── Mapping ──

function mapThread(gql: GqlThread): PrThread | null {
  const comments = gql.comments.nodes;
  if (comments.length === 0) return null;

  const root = comments[0];
  const user = root.author?.login ?? "unknown";
  const location = root.path ? `${root.path}:${root.line ?? 0}` : "unknown";

  return {
    threadId: gql.id,
    rootCommentId: root.databaseId,
    user,
    location,
    body: root.body,
    resolved: gql.isResolved,
    outdated: gql.isOutdated,
    replies: comments.slice(1).map((c) => ({
      user: c.author?.login ?? "unknown",
      body: c.body,
      commentId: c.databaseId,
    })),
  };
}

function mapReview(gql: GqlReview): PrReviewEntry {
  return {
    id: gql.databaseId,
    user: gql.author?.login ?? "unknown",
    state: gql.state,
    body: gql.body,
  };
}

function mapComment(gql: GqlComment): PrCommentEntry {
  return {
    id: gql.databaseId,
    user: gql.author?.login ?? "unknown",
    body: gql.body,
  };
}

// ── Handler ──

export class PrThreadHandlers {
  private inflight = new Map<string, Promise<PrThreadSnapshot>>();

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("getPrThreadSnapshot", async (params) => {
      const { prNumber, repoRoot, includeResolved } = GetPrThreadSnapshotParamsSchema.parse(params);
      const key = `${repoRoot}:${prNumber}:${includeResolved ?? false}`;

      const existing = this.inflight.get(key);
      if (existing) return existing;

      const promise = this.fetchSnapshot(prNumber, repoRoot, includeResolved ?? false);
      this.inflight.set(key, promise);
      try {
        return await promise;
      } finally {
        this.inflight.delete(key);
      }
    });
  }

  private async fetchSnapshot(prNumber: number, repoRoot: string, includeResolved: boolean): Promise<PrThreadSnapshot> {
    const client = createGhClient({ repoRoot });

    const data = await client.graphql<GqlResponse>(REVIEW_THREADS_QUERY, {
      ...(await this.resolveOwnerRepo(repoRoot)),
      number: prNumber,
    });

    const pr = data.repository.pullRequest;

    const threads: PrThread[] = [];
    for (const gqlThread of pr.reviewThreads.nodes) {
      const thread = mapThread(gqlThread);
      if (!thread) continue;
      if (!includeResolved && thread.resolved) continue;
      if (isBotNoise(thread)) continue;
      threads.push(thread);
    }

    const reviews = pr.reviews.nodes.map(mapReview).filter((r) => !isBotNoise(r));

    const topLevelComments = pr.comments.nodes.map(mapComment).filter((c) => !isBotNoise(c));

    const truncated =
      pr.reviewThreads.pageInfo.hasNextPage ||
      pr.reviews.pageInfo.hasNextPage ||
      pr.comments.pageInfo.hasNextPage ||
      pr.reviewThreads.nodes.some((t) => t.comments.pageInfo.hasNextPage);

    return {
      threads,
      reviews,
      topLevelComments,
      fetchedAt: new Date().toISOString(),
      pushedAt: pr.pushedAt,
      truncated,
    };
  }

  private async resolveOwnerRepo(repoRoot: string): Promise<{ owner: string; repo: string }> {
    const result = await spawnCapture("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    if (!result.ok) {
      throw new Error(`Failed to detect GitHub repo from git remote in ${repoRoot}`);
    }
    return parseGitRemoteUrl(result.stdout.trim());
  }
}
