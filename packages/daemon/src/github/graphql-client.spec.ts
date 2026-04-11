import { afterEach, describe, expect, test } from "bun:test";
import { buildQuery, clearTokenCache, fetchTrackedPRs, getGhToken, parseRemoteUrl } from "./graphql-client";

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
});
