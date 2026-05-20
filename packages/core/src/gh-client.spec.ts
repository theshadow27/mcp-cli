import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  GhAuthError,
  GhClient,
  GhNotFoundError,
  GhPageCapError,
  GhRateLimitError,
  type GhRepoInfo,
  GhServerError,
  GhValidationError,
  _clearTokenCache,
  createGhClient,
  parseGitRemoteUrl,
} from "./gh-client";

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });

    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;

    const headers = new Headers(resp.headers ?? {});
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers,
    });
  };

  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

function makeClient(opts: {
  fetch: typeof globalThis.fetch;
  owner?: string;
  repo?: string;
  getToken?: () => Promise<string>;
}): GhClient {
  return new GhClient({
    repoRoot: "/tmp/test",
    owner: opts.owner ?? "test-owner",
    repo: opts.repo ?? "test-repo",
    getToken: opts.getToken ?? (async () => "test-token"),
    fetch: opts.fetch,
  });
}

beforeEach(() => {
  _clearTokenCache();
});

// ── parseGitRemoteUrl ──

describe("parseGitRemoteUrl", () => {
  test("SSH format", () => {
    expect(parseGitRemoteUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("HTTPS format", () => {
    expect(parseGitRemoteUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("HTTPS without .git", () => {
    expect(parseGitRemoteUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("throws on non-GitHub URL", () => {
    expect(() => parseGitRemoteUrl("https://gitlab.com/owner/repo")).toThrow("Cannot parse GitHub");
  });
});

// ── createGhClient factory ──

describe("createGhClient", () => {
  test("returns a GhClient instance", () => {
    const client = createGhClient({ repoRoot: "/tmp/test" });
    expect(client).toBeInstanceOf(GhClient);
  });
});

// ── PR Handle ──

describe("PrHandle", () => {
  test("body() fetches and maps PR data", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          number: 42,
          title: "Test PR",
          body: "Description",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          labels: [{ name: "bug" }, { name: "priority" }],
          mergeable: true,
          mergeable_state: "clean",
          merge_commit_sha: "abc123",
          head: { ref: "feature", sha: "def456" },
          base: { ref: "main" },
          user: { login: "alice" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
        },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const pr = await client.pr(42).body();

    expect(pr.number).toBe(42);
    expect(pr.title).toBe("Test PR");
    expect(pr.labels).toEqual(["bug", "priority"]);
    expect(pr.head.ref).toBe("feature");
    expect(pr.user).toBe("alice");
    expect(calls[0].url).toContain("/repos/test-owner/test-repo/pulls/42");
  });

  test("bodyComments() fetches paginated issue comments", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: [
          {
            id: 1,
            body: "LGTM",
            user: { login: "bob" },
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
          {
            id: 2,
            body: "Fix this",
            user: { login: "alice" },
            created_at: "2024-01-02T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
          },
        ],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const comments = await client.pr(42).bodyComments();

    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe("LGTM");
    expect(comments[0].user).toBe("bob");
    expect(comments[1].user).toBe("alice");
  });

  test("inlineComments() fetches review comments", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: [
          {
            id: 10,
            body: "Nit",
            path: "src/main.ts",
            line: 5,
            original_line: 5,
            in_reply_to_id: null,
            user: { login: "reviewer" },
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
        ],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const comments = await client.pr(42).inlineComments();

    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe("src/main.ts");
    expect(comments[0].line).toBe(5);
  });

  test("reviews() fetches PR reviews", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: [
          { id: 100, state: "APPROVED", body: "", user: { login: "approver" }, submitted_at: "2024-01-01T00:00:00Z" },
          {
            id: 101,
            state: "CHANGES_REQUESTED",
            body: "Fix X",
            user: { login: "reviewer" },
            submitted_at: "2024-01-02T00:00:00Z",
          },
        ],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const reviews = await client.pr(42).reviews();

    expect(reviews).toHaveLength(2);
    expect(reviews[0].state).toBe("APPROVED");
    expect(reviews[1].state).toBe("CHANGES_REQUESTED");
  });

  test("files() fetches changed files", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: [{ filename: "src/index.ts", status: "modified", additions: 10, deletions: 5 }],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const files = await client.pr(42).files();

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("src/index.ts");
    expect(files[0].additions).toBe(10);
  });

  test("comment() posts a comment", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 201,
        body: {
          id: 99,
          body: "Hello!",
          user: { login: "bot" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const comment = await client.pr(42).comment("Hello!");

    expect(comment.body).toBe("Hello!");
    expect(calls[0].url).toContain("/issues/42/comments");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ body: "Hello!" });
  });

  test("edit() patches PR and manages labels", async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: {} },
      { status: 200, body: [{ name: "qa:pass" }] },
      { status: 204, body: null },
    ]);

    const client = makeClient({ fetch: fn });
    await client.pr(42).edit({
      title: "New title",
      addLabels: ["qa:pass"],
      removeLabels: ["qa:fail"],
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[1].init.method).toBe("POST");
    expect(calls[2].init.method).toBe("DELETE");
  });

  test("merge() squash-merges a PR", async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { merged: true } }]);

    const client = makeClient({ fetch: fn });
    await client.pr(42).merge({ method: "squash" });

    expect(calls[0].url).toContain("/pulls/42/merge");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ merge_method: "squash" });
  });

  test("merge() with deleteBranch deletes the branch after merge", async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: { merged: true } },
      {
        status: 200,
        body: {
          number: 42,
          title: "PR",
          body: null,
          state: "closed",
          draft: false,
          merged: false,
          merged_at: null,
          labels: [],
          mergeable: null,
          mergeable_state: "",
          merge_commit_sha: null,
          head: { ref: "feature-branch", sha: "abc" },
          base: { ref: "main" },
          user: { login: "alice" },
          created_at: "",
          updated_at: "",
        },
      },
      { status: 204, body: null },
    ]);

    const client = makeClient({ fetch: fn });
    await client.pr(42).merge({ method: "squash", deleteBranch: true });

    expect(calls).toHaveLength(3);
    expect(calls[2].url).toContain("/git/refs/heads/feature-branch");
    expect(calls[2].init.method).toBe("DELETE");
  });

  test("checks() merges check-runs and commit statuses, deduplicating by context", async () => {
    const prBody = {
      number: 42,
      title: "PR",
      body: null,
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      labels: [],
      mergeable: null,
      mergeable_state: "",
      merge_commit_sha: null,
      head: { ref: "feat", sha: "abc123" },
      base: { ref: "main" },
      user: { login: "alice" },
      created_at: "",
      updated_at: "",
    };

    const { fn, calls } = mockFetch([
      { status: 200, body: prBody },
      {
        status: 200,
        body: {
          total_count: 1,
          check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "SUCCESS" }],
        },
      },
      {
        status: 200,
        body: [
          { context: "ci/legacy", state: "success", description: null },
          { context: "ci/legacy", state: "failure", description: null },
          { context: "ci/other", state: "pending", description: null },
        ],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const result = await client.pr(42).checks();

    expect(result.total_count).toBe(1);
    expect(result.check_runs).toHaveLength(1);
    expect(result.check_runs[0].conclusion).toBe("SUCCESS");

    // 2 unique contexts (ci/legacy deduped, ci/other = pending → null conclusion)
    expect(result.commit_statuses).toHaveLength(2);
    const legacy = result.commit_statuses.find((s) => s.name === "ci/legacy");
    expect(legacy?.conclusion).toBe("SUCCESS");
    const other = result.commit_statuses.find((s) => s.name === "ci/other");
    expect(other?.conclusion).toBeNull();

    expect(calls[1].url).toContain("/commits/abc123/check-runs");
    expect(calls[2].url).toContain("/commits/abc123/statuses");
  });

  test("checks() maps failure/error statuses to FAILURE conclusion", async () => {
    const prBody = {
      number: 1,
      title: "T",
      body: null,
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      labels: [],
      mergeable: null,
      mergeable_state: "",
      merge_commit_sha: null,
      head: { ref: "f", sha: "sha1" },
      base: { ref: "main" },
      user: { login: "u" },
      created_at: "",
      updated_at: "",
    };

    const { fn } = mockFetch([
      { status: 200, body: prBody },
      { status: 200, body: { total_count: 0, check_runs: [] } },
      {
        status: 200,
        body: [
          { context: "ctx/fail", state: "failure", description: null },
          { context: "ctx/error", state: "error", description: null },
        ],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const result = await client.pr(1).checks();

    expect(result.commit_statuses).toHaveLength(2);
    expect(result.commit_statuses.every((s) => s.conclusion === "FAILURE")).toBe(true);
  });

  test("allCommentSurfaces() combines all 4 surfaces", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: [{ id: 1, body: "body comment", user: { login: "alice" }, created_at: "", updated_at: "" }],
      },
      {
        status: 200,
        body: [
          {
            id: 2,
            body: "inline",
            path: "a.ts",
            line: 1,
            original_line: 1,
            in_reply_to_id: null,
            user: { login: "bob" },
            created_at: "",
            updated_at: "",
          },
        ],
      },
      { status: 200, body: [{ id: 3, state: "APPROVED", body: "", user: { login: "charlie" }, submitted_at: "" }] },
      {
        status: 200,
        body: [{ id: 4, body: "issue comment", user: { login: "alice" }, created_at: "", updated_at: "" }],
      },
    ]);

    const client = makeClient({ fetch: fn });
    const result = await client.pr(42).allCommentSurfaces({ linkedIssue: 100 });

    expect(result.bodyComments).toHaveLength(1);
    expect(result.inlineComments).toHaveLength(1);
    expect(result.reviews).toHaveLength(1);
    expect(result.issueComments).toHaveLength(1);
    expect(result.unrepliedTopLevelCount).toBe(1);
    expect(Object.keys(result.byAuthor)).toEqual(["alice", "bob", "charlie"]);
    expect(result.byAuthor.alice).toHaveLength(2);
  });

  test("allCommentSurfaces() filters bots from substantiveByAuthor", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: [{ id: 1, body: "bot says hi", user: { login: "copilot[bot]" }, created_at: "", updated_at: "" }],
      },
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);

    const client = makeClient({ fetch: fn });
    const result = await client.pr(42).allCommentSurfaces();

    expect(result.byAuthor["copilot[bot]"]).toHaveLength(1);
    expect(result.substantiveByAuthor["copilot[bot]"]).toBeUndefined();
  });
});

// ── Issue Handle ──

describe("IssueHandle", () => {
  test("body() fetches and maps issue data", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: {
          number: 100,
          title: "Bug",
          body: "Steps to reproduce",
          state: "open",
          labels: [{ name: "bug" }],
          user: { login: "reporter" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const issue = await client.issue(100).body();

    expect(issue.number).toBe(100);
    expect(issue.title).toBe("Bug");
    expect(issue.labels).toEqual(["bug"]);
  });

  test("comment() posts a comment", async () => {
    const { fn } = mockFetch([
      {
        status: 201,
        body: { id: 50, body: "Noted", user: { login: "maintainer" }, created_at: "", updated_at: "" },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const comment = await client.issue(100).comment("Noted");
    expect(comment.body).toBe("Noted");
  });

  test("edit() patches issue", async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: {} }]);

    const client = makeClient({ fetch: fn });
    await client.issue(100).edit({ state: "closed", labels: ["wontfix"] });

    expect(calls[0].init.method).toBe("PATCH");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.state).toBe("closed");
    expect(body.labels).toEqual(["wontfix"]);
  });

  test("edit({}) with empty opts is a no-op", async () => {
    const { fn, calls } = mockFetch([{ status: 422, body: { message: "should not be called" } }]);

    const client = makeClient({ fetch: fn });
    await client.issue(100).edit({});

    expect(calls).toHaveLength(0);
  });
});

// ── Repo Handle ──

describe("RepoHandle", () => {
  test("searchIssues() calls search API with repo scope", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          total_count: 1,
          items: [{ number: 42, title: "Bug", state: "open", labels: [{ name: "bug" }] }],
        },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const result = await client.repo().searchIssues({ query: "is:open" });

    expect(result.total_count).toBe(1);
    expect(result.items[0].number).toBe(42);
    expect(calls[0].url).toContain("repo%3Atest-owner%2Ftest-repo");
  });
});

// ── Auth ──

describe("auth resolution", () => {
  test("uses GH_TOKEN env var", async () => {
    const original = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "env-token";
    try {
      const { fn, calls } = mockFetch([
        {
          status: 200,
          body: {
            number: 1,
            title: "T",
            body: null,
            state: "open",
            draft: false,
            labels: [],
            mergeable: null,
            mergeable_state: "",
            merge_commit_sha: null,
            head: { ref: "f", sha: "a" },
            base: { ref: "main" },
            user: { login: "u" },
            created_at: "",
            updated_at: "",
          },
        },
      ]);
      const client = new GhClient({
        repoRoot: "/tmp/test",
        owner: "o",
        repo: "r",
        fetch: fn,
      });
      await client.pr(1).body();
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("bearer env-token");
    } finally {
      if (original !== undefined) process.env.GH_TOKEN = original;
      else Reflect.deleteProperty(process.env, "GH_TOKEN");
    }
  });
});

// ── Pagination ──

describe("pagination", () => {
  test("auto-paginates across 3 pages", async () => {
    const page1 = [{ id: 1, body: "c1", user: { login: "a" }, created_at: "", updated_at: "" }];
    const page2 = [{ id: 2, body: "c2", user: { login: "b" }, created_at: "", updated_at: "" }];
    const page3 = [{ id: 3, body: "c3", user: { login: "c" }, created_at: "", updated_at: "" }];

    let callIdx = 0;
    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callIdx++;
      if (callIdx === 1) {
        return new Response(JSON.stringify(page1), {
          status: 200,
          headers: { link: '<https://api.github.com/next?page=2>; rel="next"' },
        });
      }
      if (callIdx === 2) {
        return new Response(JSON.stringify(page2), {
          status: 200,
          headers: { link: '<https://api.github.com/next?page=3>; rel="next"' },
        });
      }
      return new Response(JSON.stringify(page3), { status: 200 });
    };

    const client = makeClient({ fetch: fn as unknown as typeof globalThis.fetch });
    const comments = await client.pr(42).bodyComments();

    expect(comments).toHaveLength(3);
    expect(comments.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  test("throws GhPageCapError when MAX_PAGES hit with next link present", async () => {
    // Provide a fetch fn that always returns a next link, simulating an
    // infinite paginated resource. ghPaginated should throw after MAX_PAGES.
    let callCount = 0;
    const alwaysNextFn = async (): Promise<Response> => {
      callCount++;
      return new Response(
        JSON.stringify([{ id: callCount, body: "c", user: { login: "a" }, created_at: "", updated_at: "" }]),
        {
          status: 200,
          headers: { link: `<https://api.github.com/repos/o/r/issues/42/comments?page=${callCount + 1}>; rel="next"` },
        },
      );
    };

    const client = makeClient({ fetch: alwaysNextFn as unknown as typeof globalThis.fetch });

    try {
      await client.pr(42).bodyComments();
      expect.unreachable("should have thrown GhPageCapError");
    } catch (err) {
      expect(err).toBeInstanceOf(GhPageCapError);
      expect((err as GhPageCapError).itemCount).toBeGreaterThan(0);
      expect((err as GhPageCapError).message).toContain("MAX_PAGES");
    }
  });
});

// ── Error handling ──

describe("error handling", () => {
  test("401 clears token cache and retries once", async () => {
    let attempt = 0;
    const fn = async (): Promise<Response> => {
      attempt++;
      if (attempt === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(
        JSON.stringify({
          number: 1,
          title: "T",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          labels: [],
          mergeable: null,
          mergeable_state: "",
          merge_commit_sha: null,
          head: { ref: "f", sha: "a" },
          base: { ref: "main" },
          user: { login: "u" },
          created_at: "",
          updated_at: "",
        }),
        { status: 200 },
      );
    };

    const client = makeClient({ fetch: fn as unknown as typeof globalThis.fetch });
    const pr = await client.pr(1).body();
    expect(pr.number).toBe(1);
    expect(attempt).toBe(2);
  });

  test("404 throws GhNotFoundError", async () => {
    const { fn } = mockFetch([{ status: 404, body: { message: "Not Found" } }]);
    const client = makeClient({ fetch: fn });

    try {
      await client.pr(999).body();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhNotFoundError);
    }
  });

  test("422 throws GhValidationError with errors array", async () => {
    const { fn } = mockFetch([
      {
        status: 422,
        body: { message: "Validation Failed", errors: [{ field: "title", code: "missing" }] },
      },
    ]);
    const client = makeClient({ fetch: fn });

    try {
      await client.issue(1).edit({ title: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhValidationError);
      expect((err as GhValidationError).errors).toHaveLength(1);
    }
  });

  test("422 with malformed body still throws GhValidationError and warns", async () => {
    const rawBody = "not { valid json body }";
    const fn = async (): Promise<Response> => new Response(rawBody, { status: 422 });
    const client = makeClient({ fetch: fn as unknown as typeof globalThis.fetch });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await client.issue(1).edit({ title: "test" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhValidationError);
      expect((err as GhValidationError).errors).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toBe("gh-client: failed to parse 422 response body");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("403 with remaining=0 throws GhRateLimitError", async () => {
    const { fn } = mockFetch([
      {
        status: 403,
        body: { message: "rate limit" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
      },
    ]);
    const client = makeClient({ fetch: fn });

    try {
      await client.pr(1).body();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhRateLimitError);
      expect((err as GhRateLimitError).resetAt).toBeInstanceOf(Date);
    }
  });

  test("429 respects Retry-After header", async () => {
    let attempt = 0;
    const fn = async (): Promise<Response> => {
      attempt++;
      if (attempt === 1) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return new Response(
        JSON.stringify({
          number: 1,
          title: "T",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          labels: [],
          mergeable: null,
          mergeable_state: "",
          merge_commit_sha: null,
          head: { ref: "f", sha: "a" },
          base: { ref: "main" },
          user: { login: "u" },
          created_at: "",
          updated_at: "",
        }),
        { status: 200 },
      );
    };

    const start = Date.now();
    const client = makeClient({ fetch: fn as unknown as typeof globalThis.fetch });
    const pr = await client.pr(1).body();
    const elapsed = Date.now() - start;

    expect(pr.number).toBe(1);
    expect(attempt).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  test("5xx retries with exponential backoff", async () => {
    let attempt = 0;
    const fn = async (): Promise<Response> => {
      attempt++;
      if (attempt <= 2) {
        return new Response("Server Error", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          number: 1,
          title: "T",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          labels: [],
          mergeable: null,
          mergeable_state: "",
          merge_commit_sha: null,
          head: { ref: "f", sha: "a" },
          base: { ref: "main" },
          user: { login: "u" },
          created_at: "",
          updated_at: "",
        }),
        { status: 200 },
      );
    };

    const client = makeClient({ fetch: fn as unknown as typeof globalThis.fetch });
    const pr = await client.pr(1).body();

    expect(pr.number).toBe(1);
    expect(attempt).toBe(3);
  });

  test("5xx exhausted throws GhServerError", async () => {
    const fn = async (): Promise<Response> => {
      return new Response("Server Error", { status: 502 });
    };

    const client = makeClient({ fetch: fn as unknown as typeof globalThis.fetch });

    try {
      await client.pr(1).body();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhServerError);
      expect((err as GhServerError).status).toBe(502);
    }
  });
});

// ── GraphQL escape hatch ──

describe("graphql", () => {
  test("sends query and returns data", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: { data: { viewer: { login: "testuser" } } },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const result = await client.graphql<{ viewer: { login: string } }>("{ viewer { login } }");

    expect(result.viewer.login).toBe("testuser");
    expect(calls[0].url).toBe("https://api.github.com/graphql");
  });

  test("throws GhValidationError on GraphQL errors", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: { errors: [{ message: "Field 'foo' not found" }] },
      },
    ]);

    const client = makeClient({ fetch: fn });

    try {
      await client.graphql("{ foo }");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GhValidationError);
    }
  });
});

// ── REST escape hatch ──

describe("rest", () => {
  test("passes method and body through", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: { id: 1, name: "test-label" },
      },
    ]);

    const client = makeClient({ fetch: fn });
    await client.rest("POST", "/repos/o/r/labels", { name: "test-label", color: "ff0000" });

    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string).name).toBe("test-label");
  });
});

// ── rateLimit ──

describe("rateLimit", () => {
  test("returns parsed rate limit info", async () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 3600;
    const { fn } = mockFetch([
      {
        status: 200,
        body: { rate: { limit: 5000, remaining: 4999, reset: resetTimestamp, used: 1 } },
      },
    ]);

    const client = makeClient({ fetch: fn });
    const info = await client.rateLimit();

    expect(info.limit).toBe(5000);
    expect(info.remaining).toBe(4999);
    expect(info.used).toBe(1);
    expect(info.reset).toBeInstanceOf(Date);
  });
});

// ── validate ──

describe("validate", () => {
  test("resolves without error when token and repo are valid", async () => {
    const { fn } = mockFetch([]);
    const client = makeClient({ fetch: fn });
    await expect(client.validate()).resolves.toBeUndefined();
  });

  test("throws GhAuthError eagerly when token resolution fails", async () => {
    const { fn } = mockFetch([]);
    const client = new GhClient({
      repoRoot: "/tmp/test",
      owner: "o",
      repo: "r",
      getToken: async () => {
        throw new GhAuthError("no token");
      },
      fetch: fn,
    });
    await expect(client.validate()).rejects.toBeInstanceOf(GhAuthError);
  });

  test("is safe to call multiple times (env-var path)", async () => {
    const { fn } = mockFetch([]);
    const client = makeClient({ fetch: fn });
    await expect(client.validate()).resolves.toBeUndefined();
    await expect(client.validate()).resolves.toBeUndefined();
  });

  test("caches token resolution for getToken clients", async () => {
    let callCount = 0;
    const { fn } = mockFetch([]);
    const client = new GhClient({
      repoRoot: "/tmp/test",
      owner: "o",
      repo: "r",
      getToken: async () => {
        callCount++;
        return "gho_custom";
      },
      fetch: fn,
    });
    await client.validate();
    await client.validate();
    await client.validate();
    expect(callCount).toBe(1);
  });
});
