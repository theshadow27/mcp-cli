import { afterEach, describe, expect, test } from "bun:test";
import {
  buildQuery,
  clearTokenCache,
  fetchTrackedPRs,
  getGhToken,
  parseRemoteUrl,
  pickBestLinkedPR,
  resolveNumber,
} from "./graphql-client";

afterEach(() => {
  clearTokenCache();
});

// ---------- parseRemoteUrl ----------

describe("parseRemoteUrl", () => {
  test("parses HTTPS URL", () => {
    expect(parseRemoteUrl("https://github.com/theshadow27/mcp-cli.git")).toEqual({
      owner: "theshadow27",
      repo: "mcp-cli",
    });
  });

  test("parses HTTPS URL without .git", () => {
    expect(parseRemoteUrl("https://github.com/theshadow27/mcp-cli")).toEqual({
      owner: "theshadow27",
      repo: "mcp-cli",
    });
  });

  test("parses SSH URL", () => {
    expect(parseRemoteUrl("git@github.com:theshadow27/mcp-cli.git")).toEqual({
      owner: "theshadow27",
      repo: "mcp-cli",
    });
  });

  test("parses SSH URL without .git", () => {
    expect(parseRemoteUrl("git@github.com:theshadow27/mcp-cli")).toEqual({
      owner: "theshadow27",
      repo: "mcp-cli",
    });
  });

  test("throws on non-GitHub URL", () => {
    expect(() => parseRemoteUrl("https://gitlab.com/foo/bar.git")).toThrow("Cannot parse GitHub");
  });

  test("throws on garbage", () => {
    expect(() => parseRemoteUrl("not-a-url")).toThrow("Cannot parse GitHub");
  });
});

// ---------- buildQuery ----------

describe("buildQuery", () => {
  test("builds aliased query for multiple PRs", () => {
    const q = buildQuery([42, 99]);
    expect(q).toContain("pr42: pullRequest(number: 42)");
    expect(q).toContain("pr99: pullRequest(number: 99)");
    expect(q).toContain("$owner: String!");
    expect(q).toContain("$repo: String!");
  });

  test("builds single PR query", () => {
    const q = buildQuery([1]);
    expect(q).toContain("pr1: pullRequest(number: 1)");
  });
});

// ---------- getGhToken ----------

describe("getGhToken", () => {
  test("caches token across calls", async () => {
    let callCount = 0;
    const exec = async () => {
      callCount++;
      return "ghp_test123";
    };

    const t1 = await getGhToken({ exec });
    const t2 = await getGhToken({ exec });
    expect(t1).toBe("ghp_test123");
    expect(t2).toBe("ghp_test123");
    expect(callCount).toBe(1);
  });

  test("refreshes after clearTokenCache", async () => {
    let callCount = 0;
    const exec = async () => {
      callCount++;
      return `token-${callCount}`;
    };

    await getGhToken({ exec });
    clearTokenCache();
    const t2 = await getGhToken({ exec });
    expect(t2).toBe("token-2");
    expect(callCount).toBe(2);
  });
});

// ---------- fetchTrackedPRs ----------

describe("fetchTrackedPRs", () => {
  const repo = { owner: "test", repo: "repo" };

  function mockFetch(body: unknown, status = 200) {
    return async () => new Response(JSON.stringify(body), { status });
  }

  const mockGetToken = async () => "fake-token";

  test("returns empty array for no PR numbers", async () => {
    const result = await fetchTrackedPRs(repo, [], { getToken: mockGetToken });
    expect(result).toEqual([]);
  });

  test("parses successful GraphQL response", async () => {
    const body = {
      data: {
        repository: {
          pr42: {
            number: 42,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        nodes: [{ name: "ci/test", status: "COMPLETED", conclusion: "SUCCESS" }],
                      },
                    },
                  },
                },
              ],
            },
            reviews: {
              nodes: [{ state: "APPROVED", author: { login: "reviewer1" } }],
            },
          },
        },
      },
    };

    const result = await fetchTrackedPRs(repo, [42], {
      getToken: mockGetToken,
      fetch: mockFetch(body),
    });

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(42);
    expect(result[0].state).toBe("OPEN");
    expect(result[0].isDraft).toBe(false);
    expect(result[0].mergeable).toBe("MERGEABLE");
    expect(result[0].ciState).toBe("SUCCESS");
    expect(result[0].ciChecks).toHaveLength(1);
    expect(result[0].ciChecks[0].name).toBe("ci/test");
    expect(result[0].reviews).toHaveLength(1);
    expect(result[0].reviews[0].state).toBe("APPROVED");
    expect(result[0].reviews[0].author).toBe("reviewer1");
  });

  test("retries on 401", async () => {
    let callCount = 0;
    const doFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ data: { repository: {} } }), { status: 200 });
    };

    let tokenCallCount = 0;
    const getToken = async () => {
      tokenCallCount++;
      return `token-${tokenCallCount}`;
    };

    await fetchTrackedPRs(repo, [1], { getToken, fetch: doFetch });
    expect(callCount).toBe(2);
    expect(tokenCallCount).toBe(2); // first call + refresh
  });

  test("throws on GraphQL errors", async () => {
    const body = { errors: [{ message: "Not found" }] };
    await expect(fetchTrackedPRs(repo, [1], { getToken: mockGetToken, fetch: mockFetch(body) })).rejects.toThrow(
      "GitHub GraphQL errors: Not found",
    );
  });

  test("throws on non-200 after retry", async () => {
    const doFetch = async () => new Response("Server Error", { status: 500 });

    await expect(fetchTrackedPRs(repo, [1], { getToken: mockGetToken, fetch: doFetch })).rejects.toThrow(
      "GitHub GraphQL API returned 500",
    );
  });

  test("handles missing repository data", async () => {
    const body = { data: {} };
    const result = await fetchTrackedPRs(repo, [1], {
      getToken: mockGetToken,
      fetch: mockFetch(body),
    });
    expect(result).toEqual([]);
  });

  test("clears token cache on 403 non-rate-limit", async () => {
    const doFetch = async () => new Response("Forbidden", { status: 403, headers: {} });

    let tokenCallCount = 0;
    const getToken = async () => {
      tokenCallCount++;
      return `token-${tokenCallCount}`;
    };

    await expect(fetchTrackedPRs(repo, [1], { getToken, fetch: doFetch })).rejects.toThrow(
      "403 (possible token scope change)",
    );
    // Token should have been fetched once, then cache cleared for next poll
    expect(tokenCallCount).toBe(1);
  });

  test("throws rate limit error on 403 with exhausted limit", async () => {
    const resetTime = Math.floor(Date.now() / 1000) + 3600;
    const doFetch = async () =>
      new Response("Rate limited", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetTime),
        },
      });

    await expect(fetchTrackedPRs(repo, [1], { getToken: mockGetToken, fetch: doFetch })).rejects.toThrow(
      "rate limit exhausted",
    );
  });

  test("handles PR with no CI or reviews", async () => {
    const body = {
      data: {
        repository: {
          pr10: {
            number: 10,
            state: "MERGED",
            isDraft: false,
            mergeable: "UNKNOWN",
            commits: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      },
    };

    const result = await fetchTrackedPRs(repo, [10], {
      getToken: mockGetToken,
      fetch: mockFetch(body),
    });

    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("MERGED");
    expect(result[0].ciState).toBeNull();
    expect(result[0].ciChecks).toEqual([]);
    expect(result[0].reviews).toEqual([]);
  });

  test("parses enriched fields: commitCount, headRefName, baseRefName, mergeCommitOid, files", async () => {
    const body = {
      data: {
        repository: {
          pr77: {
            number: 77,
            state: "MERGED",
            isDraft: false,
            mergeable: "MERGEABLE",
            headRefName: "feat/my-feature",
            baseRefName: "main",
            commits: {
              totalCount: 5,
              nodes: [],
            },
            reviews: { nodes: [] },
            files: {
              nodes: [
                { path: "src/a.ts", additions: 10, deletions: 3 },
                { path: "src/a.spec.ts", additions: 5, deletions: 1 },
              ],
            },
            mergeCommit: { oid: "abc123def456" },
          },
        },
      },
    };

    const result = await fetchTrackedPRs(repo, [77], { getToken: mockGetToken, fetch: mockFetch(body) });

    expect(result).toHaveLength(1);
    const pr = result[0];
    expect(pr.commitCount).toBe(5);
    expect(pr.headRefName).toBe("feat/my-feature");
    expect(pr.baseRefName).toBe("main");
    expect(pr.mergeCommitOid).toBe("abc123def456");
    expect(pr.files).toHaveLength(2);
    expect(pr.files[0]).toEqual({ path: "src/a.ts", additions: 10, deletions: 3 });
    expect(pr.files[1]).toEqual({ path: "src/a.spec.ts", additions: 5, deletions: 1 });
  });

  test("logs warning when rateLimit.remaining drops below 500", async () => {
    const body = {
      data: {
        rateLimit: { remaining: 250 },
        repository: {
          pr1: {
            number: 1,
            state: "OPEN",
            isDraft: false,
            mergeable: "UNKNOWN",
            commits: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      },
    };

    const warnings: string[] = [];
    const result = await fetchTrackedPRs(repo, [1], {
      getToken: mockGetToken,
      fetch: mockFetch(body),
      warn: (msg) => warnings.push(msg),
    });

    expect(result).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("250");
    expect(warnings[0]).toContain("rate limit");
  });

  test("does not warn when rateLimit.remaining is above threshold", async () => {
    const body = {
      data: {
        rateLimit: { remaining: 4000 },
        repository: {
          pr1: {
            number: 1,
            state: "OPEN",
            isDraft: false,
            mergeable: "UNKNOWN",
            commits: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      },
    };

    const warnings: string[] = [];
    await fetchTrackedPRs(repo, [1], {
      getToken: mockGetToken,
      fetch: mockFetch(body),
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings).toHaveLength(0);
  });
});

// ---------- resolveNumber ----------

describe("resolveNumber", () => {
  const repo = { owner: "test", repo: "repo" };
  const mockGetToken = async () => "fake-token";

  function mockFetch(body: unknown, status = 200) {
    return async () => new Response(JSON.stringify(body), { status });
  }

  test("identifies a PR number directly", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "PullRequest",
            number: 42,
          },
        },
      },
    };

    const result = await resolveNumber(repo, 42, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: true, prNumber: 42 });
  });

  test("resolves linked PR from issue via ConnectedEvent", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            timelineItems: {
              nodes: [
                {
                  __typename: "ConnectedEvent",
                  subject: { __typename: "PullRequest", number: 99 },
                },
              ],
            },
          },
        },
      },
    };

    const result = await resolveNumber(repo, 50, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: 99 });
  });

  test("resolves linked PR from issue via CrossReferencedEvent", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            timelineItems: {
              nodes: [
                {
                  __typename: "CrossReferencedEvent",
                  source: { __typename: "PullRequest", number: 77 },
                },
              ],
            },
          },
        },
      },
    };

    const result = await resolveNumber(repo, 50, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: 77 });
  });

  test("returns null prNumber when issue has no linked PR", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            timelineItems: { nodes: [] },
          },
        },
      },
    };

    const result = await resolveNumber(repo, 50, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: null });
  });

  test("returns null when number not found", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: null,
        },
      },
    };

    const result = await resolveNumber(repo, 9999, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: null });
  });

  test("throws on API error", async () => {
    await expect(
      resolveNumber(repo, 1, { getToken: mockGetToken, fetch: mockFetch("Server Error", 500) }),
    ).rejects.toThrow("GitHub GraphQL API returned 500");
  });

  test("throws on GraphQL errors", async () => {
    const body = { errors: [{ message: "Something went wrong" }] };
    await expect(resolveNumber(repo, 1, { getToken: mockGetToken, fetch: mockFetch(body) })).rejects.toThrow(
      "GitHub GraphQL errors",
    );
  });

  test("ignores non-PR timeline events", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            timelineItems: {
              nodes: [
                {
                  __typename: "CrossReferencedEvent",
                  source: { __typename: "Issue", number: 55 },
                },
                {
                  __typename: "ConnectedEvent",
                  subject: { __typename: "Issue", number: 66 },
                },
              ],
            },
          },
        },
      },
    };

    const result = await resolveNumber(repo, 50, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: null });
  });

  test("prefers open PR over closed when multiple linked", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            timelineItems: {
              nodes: [
                {
                  __typename: "ConnectedEvent",
                  subject: { __typename: "PullRequest", number: 100, state: "CLOSED" },
                },
                {
                  __typename: "ConnectedEvent",
                  subject: { __typename: "PullRequest", number: 105, state: "OPEN" },
                },
              ],
            },
          },
        },
      },
    };

    const result = await resolveNumber(repo, 50, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: 105 });
  });

  test("picks highest-numbered PR when all same state", async () => {
    const body = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            timelineItems: {
              nodes: [
                {
                  __typename: "ConnectedEvent",
                  subject: { __typename: "PullRequest", number: 100, state: "CLOSED" },
                },
                {
                  __typename: "CrossReferencedEvent",
                  source: { __typename: "PullRequest", number: 110, state: "CLOSED" },
                },
              ],
            },
          },
        },
      },
    };

    const result = await resolveNumber(repo, 50, { getToken: mockGetToken, fetch: mockFetch(body) });
    expect(result).toEqual({ isPR: false, prNumber: 110 });
  });
});

// ---------- pickBestLinkedPR ----------

describe("pickBestLinkedPR", () => {
  test("returns only PR when single entry", () => {
    expect(pickBestLinkedPR([{ number: 42, state: "OPEN" }])).toBe(42);
  });

  test("prefers open over closed", () => {
    expect(
      pickBestLinkedPR([
        { number: 100, state: "CLOSED" },
        { number: 50, state: "OPEN" },
      ]),
    ).toBe(50);
  });

  test("picks highest number among open PRs", () => {
    expect(
      pickBestLinkedPR([
        { number: 50, state: "OPEN" },
        { number: 80, state: "OPEN" },
        { number: 200, state: "CLOSED" },
      ]),
    ).toBe(80);
  });

  test("picks highest number when no open PRs", () => {
    expect(
      pickBestLinkedPR([
        { number: 10, state: "CLOSED" },
        { number: 30, state: "MERGED" },
        { number: 20, state: "CLOSED" },
      ]),
    ).toBe(30);
  });
});
