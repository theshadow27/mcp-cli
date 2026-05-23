import { describe, expect, test } from "bun:test";
import { createMockProvider } from "./__tests__/mock-provider";
import { ExportTransaction, type ExportTransactionOptions, type PathResolver } from "./export-transaction";
import type { ParsedCommit } from "./fast-import-parser";

function makeOpts(
  overrides: Partial<ExportTransactionOptions> & {
    entries?: Record<string, { content: string; version: number }>;
  } = {},
): ExportTransactionOptions {
  const entries: Record<string, { content: string; version: number }> = overrides.entries ?? {
    "README.md": { content: "# Hello", version: 1 },
    "docs/guide.md": { content: "# Guide", version: 2 },
  };

  const provider = overrides.provider ?? createMockProvider({ entries });
  const scope = { key: "test", cloudId: "mock-cloud", resolved: {} };

  const pathMap = new Map<string, { id: string; version: number }>();
  for (const [id, entry] of Object.entries(entries)) {
    pathMap.set(id, { id, version: entry.version });
  }

  const resolvePath: PathResolver = overrides.resolvePath ?? ((path) => pathMap.get(path));

  return { provider, scope, resolvePath };
}

function commit(ref: string, changes: ParsedCommit["changes"]): ParsedCommit {
  return { ref, message: "test", changes };
}

describe("ExportTransaction", () => {
  describe("staging", () => {
    test("stages modify operations for known paths", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Updated") },
        ]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
      expect(tx.refs).toEqual(["refs/heads/main"]);
    });

    test("stages create operations for unknown paths", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "new-file.md", content: new TextEncoder().encode("# New") },
        ]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });

    test("stages delete operations for known paths", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([commit("refs/heads/main", [{ type: "delete", path: "README.md" }])]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });

    test("returns error for delete of unknown path", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([commit("refs/heads/main", [{ type: "delete", path: "nonexistent.md" }])]);
      expect(errors).toHaveLength(1);
      expect(errors[0].ok).toBe(false);
      expect(errors[0].error).toContain("cannot delete unknown path");
    });

    test("returns error for modify without content", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([commit("refs/heads/main", [{ type: "modify", path: "README.md" }])]);
      expect(errors).toHaveLength(1);
      expect(errors[0].ok).toBe(false);
      expect(errors[0].error).toContain("no content");
    });

    test("returns error for deleteall", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([commit("refs/heads/main", [{ type: "deleteall" }])]);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("deleteall not supported");
    });

    test("stages multiple commits across refs", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "README.md", content: new TextEncoder().encode("v2") }]),
        commit("refs/heads/feature", [
          { type: "modify", path: "docs/guide.md", content: new TextEncoder().encode("v3") },
        ]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(2);
      expect(tx.refs).toContain("refs/heads/main");
      expect(tx.refs).toContain("refs/heads/feature");
    });
  });

  describe("commit — success", () => {
    test("applies all staged modifications atomically", async () => {
      const provider = createMockProvider({
        entries: { "README.md": { content: "# Hello", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "README.md": { content: "# Hello", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Updated") },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs).toHaveLength(1);
      expect(result.refs[0].ok).toBe(true);
      expect(result.refs[0].ref).toBe("refs/heads/main");
      expect(result.response).toBe("ok refs/heads/main\n\n");
      expect(provider.state.get("README.md")?.content).toBe("# Updated");
    });

    test("applies create operations", async () => {
      const provider = createMockProvider({ entries: {} });
      const opts = makeOpts({ provider, entries: {} });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "new-page.md", content: new TextEncoder().encode("# New") },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.calls.create).toBe(1);
    });

    test("applies delete operations", async () => {
      const provider = createMockProvider({
        entries: { "page.md": { content: "x", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "page.md": { content: "x", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([commit("refs/heads/main", [{ type: "delete", path: "page.md" }])]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.calls.delete).toBe(1);
    });

    test("empty transaction commits successfully", async () => {
      const tx = new ExportTransaction(makeOpts());
      tx.stage([commit("refs/heads/main", [])]);
      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(result.response).toBe("ok refs/heads/main\n\n");
    });
  });

  describe("commit — partial failure", () => {
    test("version conflict fails entire transaction", async () => {
      const provider = createMockProvider({
        entries: { "README.md": { content: "# Hello", version: 2 } },
      });
      // resolvePath thinks version is 1, but provider has version 2
      const opts: ExportTransactionOptions = {
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => (path === "README.md" ? { id: "README.md", version: 1 } : undefined),
      };
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Conflict") },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(false);
      expect(result.refs[0].error).toContain("version conflict");
      expect(result.response).toContain("error refs/heads/main");
    });

    test("mid-stream failure aborts remaining operations", async () => {
      const provider = createMockProvider({
        entries: {
          "a.md": { content: "a", version: 1 },
          "b.md": { content: "b", version: 1 },
        },
      });

      // Arm push failure after first successful push
      let pushCount = 0;
      const originalPush = provider.push?.bind(provider);
      if (!originalPush) throw new Error("provider.push is undefined");
      (provider as unknown as { push: typeof originalPush }).push = async (scope, id, content, baseVersion, fm) => {
        pushCount++;
        if (pushCount === 2) throw new Error("network timeout");
        return originalPush(scope, id, content, baseVersion, fm);
      };

      const opts: ExportTransactionOptions = {
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => {
          if (path === "a.md") return { id: "a.md", version: 1 };
          if (path === "b.md") return { id: "b.md", version: 1 };
          return undefined;
        },
      };

      const tx = new ExportTransaction(opts);
      tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "a.md", content: new TextEncoder().encode("a-updated") },
          { type: "modify", path: "b.md", content: new TextEncoder().encode("b-updated") },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(false);
      expect(result.refs[0].error).toContain("network timeout");
      expect(result.response).toContain("error refs/heads/main");
    });

    test("multi-ref failure reports per-ref errors", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 1 } },
      });
      provider.armPushFailure(new Error("provider down"));

      const opts: ExportTransactionOptions = {
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => (path === "a.md" ? { id: "a.md", version: 1 } : undefined),
      };

      const tx = new ExportTransaction(opts);
      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("updated") }]),
        commit("refs/heads/feature", [{ type: "modify", path: "new.md", content: new TextEncoder().encode("new") }]),
      ]);

      const result = await tx.commit();
      // First ref fails
      const mainRef = result.refs.find((r) => r.ref === "refs/heads/main");
      expect(mainRef?.ok).toBe(false);
      expect(mainRef?.error).toContain("provider down");
      // Second ref is aborted
      const featureRef = result.refs.find((r) => r.ref === "refs/heads/feature");
      expect(featureRef?.ok).toBe(false);
      expect(featureRef?.error).toContain("aborted");
      // Response contains both error lines
      expect(result.response).toContain("error refs/heads/main");
      expect(result.response).toContain("error refs/heads/feature");
    });

    test("validation failure prevents any mutations", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 1 } },
      });
      // Override validate to reject content
      (
        provider as unknown as { validate: (c: string) => { valid: boolean; errors: string[]; warnings: string[] } }
      ).validate = (content: string) => ({
        valid: content !== "bad",
        errors: content === "bad" ? ["content is bad"] : [],
        warnings: [],
      });

      const opts: ExportTransactionOptions = {
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => (path === "a.md" ? { id: "a.md", version: 1 } : undefined),
      };

      const tx = new ExportTransaction(opts);
      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("bad") }]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(false);
      expect(result.refs[0].error).toContain("validation failed");
      // Provider was never called
      expect(provider.calls.push).toBe(0);
    });
  });

  describe("rollback", () => {
    test("rollback discards staged operations", () => {
      const tx = new ExportTransaction(makeOpts());
      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "README.md", content: new TextEncoder().encode("v2") }]),
      ]);
      expect(tx.size).toBe(1);
      tx.rollback();
      expect(tx.size).toBe(0);
    });

    test("cannot commit after rollback", async () => {
      const tx = new ExportTransaction(makeOpts());
      tx.rollback();
      await expect(tx.commit()).rejects.toThrow("already rolled back");
    });

    test("cannot rollback after commit", async () => {
      const tx = new ExportTransaction(makeOpts());
      tx.stage([commit("refs/heads/main", [])]);
      await tx.commit();
      expect(() => tx.rollback()).toThrow("already committed");
    });

    test("cannot commit twice", async () => {
      const tx = new ExportTransaction(makeOpts());
      tx.stage([commit("refs/heads/main", [])]);
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow("already committed");
    });
  });

  describe("response formatting", () => {
    test("successful single-ref response", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "a.md": { content: "a", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("updated") }]),
      ]);

      const result = await tx.commit();
      expect(result.response).toBe("ok refs/heads/main\n\n");
    });

    test("successful multi-ref response", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 1 } },
      });
      const opts: ExportTransactionOptions = {
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => (path === "a.md" ? { id: "a.md", version: 1 } : undefined),
      };
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v2") }]),
        commit("refs/heads/feature", [{ type: "modify", path: "new.md", content: new TextEncoder().encode("new") }]),
      ]);

      const result = await tx.commit();
      expect(result.response).toContain("ok refs/heads/main");
      expect(result.response).toContain("ok refs/heads/feature");
      expect(result.response).toEndWith("\n\n");
    });

    test("error response includes reason", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 2 } },
      });
      const opts: ExportTransactionOptions = {
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => (path === "a.md" ? { id: "a.md", version: 1 } : undefined),
      };
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("conflict") }]),
      ]);

      const result = await tx.commit();
      expect(result.response).toMatch(/^error refs\/heads\/main .+\n\n$/);
    });
  });
});
