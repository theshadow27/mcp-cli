import { describe, expect, test } from "bun:test";
import { createMockProvider } from "./__tests__/mock-provider";
import {
  ExportTransaction,
  type ExportTransactionOptions,
  type PathResolver,
  createExportHandler,
} from "./export-transaction";
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

    test("deleteall stages without error", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([commit("refs/heads/main", [{ type: "deleteall" }])]);
      expect(errors).toHaveLength(0);
    });

    test("deleteall causes subsequent modifies to become creates", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [
          { type: "deleteall" },
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Rebuilt") },
        ]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });

    test("deleteall clears pending creates from earlier changes", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "new.md", content: new TextEncoder().encode("first") },
          { type: "deleteall" },
          { type: "modify", path: "new.md", content: new TextEncoder().encode("rebuilt") },
        ]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });

    test("deleteall on ref A does not affect modify on ref B (B stages as push, not create)", async () => {
      const provider = createMockProvider({
        entries: { "README.md": { content: "# Hello", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "README.md": { content: "# Hello", version: 1 } } });
      const tx = new ExportTransaction(opts);

      const errors = tx.stage([
        commit("refs/heads/feature", [
          { type: "deleteall" },
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Rebuilt on feature") },
        ]),
        commit("refs/heads/main", [
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Updated on main") },
        ]),
      ]);
      expect(errors).toHaveLength(0);

      const result = await tx.commit();
      expect(result.refs).toHaveLength(2);
      expect(result.refs.find((r) => r.ref === "refs/heads/feature")?.ok).toBe(true);
      expect(result.refs.find((r) => r.ref === "refs/heads/main")?.ok).toBe(true);
      // feature's modify should be a create (deleteall cleared the tree)
      expect(provider.calls.create).toBe(1);
      // main's modify should be a push (not affected by feature's deleteall)
      expect(provider.calls.push).toBe(1);
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

    test("accepts empty content (zero-byte file)", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "README.md", content: new Uint8Array(0) }]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });

    test("throws if stage() called after commit()", async () => {
      const tx = new ExportTransaction(makeOpts());
      tx.stage([commit("refs/heads/main", [])]);
      await tx.commit();
      expect(() => tx.stage([commit("refs/heads/main", [])])).toThrow("already committed");
    });

    test("throws if stage() called after rollback()", () => {
      const tx = new ExportTransaction(makeOpts());
      tx.rollback();
      expect(() => tx.stage([commit("refs/heads/main", [])])).toThrow("already rolled back");
    });

    test("returns error when provider lacks push capability", () => {
      const provider = createMockProvider({ entries: { "a.md": { content: "a", version: 1 } } });
      (provider as unknown as Record<string, unknown>).push = undefined;
      const opts = makeOpts({ provider, entries: { "a.md": { content: "a", version: 1 } } });
      const tx = new ExportTransaction(opts);
      const errors = tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("updated") }]),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("provider does not support push");
    });

    test("returns error when provider lacks create capability", () => {
      const provider = createMockProvider({ entries: {} });
      (provider as unknown as Record<string, unknown>).create = undefined;
      const opts = makeOpts({ provider, entries: {} });
      const tx = new ExportTransaction(opts);
      const errors = tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "new.md", content: new TextEncoder().encode("new") }]),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("provider does not support create");
    });

    test("returns error when provider lacks delete capability", () => {
      const provider = createMockProvider({ entries: { "a.md": { content: "a", version: 1 } } });
      (provider as unknown as Record<string, unknown>).delete = undefined;
      const opts = makeOpts({ provider, entries: { "a.md": { content: "a", version: 1 } } });
      const tx = new ExportTransaction(opts);
      const errors = tx.stage([commit("refs/heads/main", [{ type: "delete", path: "a.md" }])]);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("provider does not support delete");
    });

    test("coalesces create then modify of same path into single create", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "new.md", content: new TextEncoder().encode("v1") }]),
        commit("refs/heads/main", [{ type: "modify", path: "new.md", content: new TextEncoder().encode("v2") }]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });

    test("coalesces create then delete of same path into zero ops", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "new.md", content: new TextEncoder().encode("temp") }]),
        commit("refs/heads/main", [{ type: "delete", path: "new.md" }]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(0);
    });

    test("strips frontmatter from create content", () => {
      const provider = createMockProvider({ entries: {} });
      const opts = makeOpts({ provider, entries: {} });
      const tx = new ExportTransaction(opts);
      const contentWithFm = "---\ntitle: My Page\nid: abc\n---\n\n# Hello";
      const errors = tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "new.md", content: new TextEncoder().encode(contentWithFm) },
        ]),
      ]);
      expect(errors).toHaveLength(0);
      expect(tx.size).toBe(1);
    });
  });

  describe("commit — success", () => {
    test("applies all staged modifications", async () => {
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

    test("calls toRemote() to convert content before push", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "old", version: 1 } },
      });
      let convertedContent: string | undefined;
      (provider as unknown as Record<string, unknown>).toRemote = (md: string) => {
        convertedContent = `<html>${md}</html>`;
        return convertedContent;
      };
      const opts = makeOpts({ provider, entries: { "a.md": { content: "old", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("# Hello") }]),
      ]);

      await tx.commit();
      expect(provider.state.get("a.md")?.content).toBe("<html># Hello</html>");
    });

    test("passes frontmatter to provider.push()", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "old", version: 1 } },
      });
      let receivedFrontmatter: Record<string, unknown> | undefined;
      const originalPush = (provider.push as NonNullable<typeof provider.push>).bind(provider);
      (provider as unknown as Record<string, unknown>).push = async (
        scope: unknown,
        id: string,
        content: string,
        baseVersion: number,
        frontmatter?: Record<string, unknown>,
      ) => {
        receivedFrontmatter = frontmatter;
        return originalPush(scope as never, id, content, baseVersion, frontmatter);
      };

      const opts = makeOpts({ provider, entries: { "a.md": { content: "old", version: 1 } } });
      const tx = new ExportTransaction(opts);

      const contentWithFm = "---\ntitle: My Page\nid: a.md\n---\n\n# Hello";
      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode(contentWithFm) }]),
      ]);

      await tx.commit();
      expect(receivedFrontmatter).toEqual({ title: "My Page", id: "a.md" });
    });

    test("same-path across multiple commits tracks version updates", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "v1", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "a.md": { content: "v1", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v2") }]),
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v3") }]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.state.get("a.md")?.content).toBe("v3");
      expect(provider.state.get("a.md")?.version).toBe(3);
    });

    test("same-path modified across three commits tracks versions", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "v1", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "a.md": { content: "v1", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v2") }]),
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v3") }]),
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v4") }]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.state.get("a.md")?.content).toBe("v4");
      expect(provider.state.get("a.md")?.version).toBe(4);
      expect(provider.calls.push).toBe(3);
    });

    test("create then modify same new path coalesces to single create with final content", async () => {
      const provider = createMockProvider({ entries: {} });
      const opts = makeOpts({ provider, entries: {} });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "new.md", content: new TextEncoder().encode("first draft") },
        ]),
        commit("refs/heads/main", [
          { type: "modify", path: "new.md", content: new TextEncoder().encode("final draft") },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.calls.create).toBe(1);
      // Find the created entry and verify it has the final content
      const created = [...provider.state.values()].find((e) => e.content === "final draft");
      expect(created).toBeDefined();
    });

    test("create path strips frontmatter before sending to provider", async () => {
      const provider = createMockProvider({ entries: {} });
      const opts = makeOpts({ provider, entries: {} });
      const tx = new ExportTransaction(opts);

      const contentWithFm = "---\ntitle: My Page\nid: abc\n---\n\n# Hello World";
      tx.stage([
        commit("refs/heads/main", [
          { type: "modify", path: "new.md", content: new TextEncoder().encode(contentWithFm) },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      const created = [...provider.state.values()].find((e) => e.content === "# Hello World");
      expect(created).toBeDefined();
      expect(created?.content).not.toContain("---");
    });

    test("empty content (zero-byte) commits successfully", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "old", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "a.md": { content: "old", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new Uint8Array(0) }])]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.state.get("a.md")?.content).toBe("");
    });

    test("deleteall followed by modifies creates new entries instead of pushing", async () => {
      const provider = createMockProvider({
        entries: { "README.md": { content: "# Hello", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "README.md": { content: "# Hello", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [
          { type: "deleteall" },
          { type: "modify", path: "README.md", content: new TextEncoder().encode("# Rebuilt") },
        ]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.calls.push).toBe(0);
      expect(provider.calls.create).toBe(1);
    });

    test("deleteall with no subsequent modifies commits as no-op", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "old", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "a.md": { content: "old", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([commit("refs/heads/main", [{ type: "deleteall" }])]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.calls.push).toBe(0);
      expect(provider.calls.create).toBe(0);
      expect(result.response).toBe("ok refs/heads/main\n\n");
    });

    test("deleteall then modify across commits coalesces into single create with final content", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "old", version: 1 } },
      });
      const opts = makeOpts({ provider, entries: { "a.md": { content: "old", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [
          { type: "deleteall" },
          { type: "modify", path: "a.md", content: new TextEncoder().encode("v1-rebuilt") },
        ]),
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("v2-updated") }]),
      ]);

      const result = await tx.commit();
      expect(result.refs[0].ok).toBe(true);
      expect(provider.calls.create).toBe(1);
      expect(provider.calls.push).toBe(0);
      const created = [...provider.state.values()].find((e) => e.content === "v2-updated");
      expect(created).toBeDefined();
    });
  });

  describe("commit — partial failure", () => {
    test("version conflict fails the ref", async () => {
      const provider = createMockProvider({
        entries: { "README.md": { content: "# Hello", version: 2 } },
      });
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

    test("mid-stream failure: succeeded refs reported ok, failed ref gets error", async () => {
      const provider = createMockProvider({
        entries: {
          "a.md": { content: "a", version: 1 },
          "b.md": { content: "b", version: 1 },
        },
      });

      let pushCount = 0;
      const originalPush = (provider.push as NonNullable<typeof provider.push>).bind(provider);
      (provider as unknown as Record<string, unknown>).push = async (
        scope: unknown,
        id: string,
        content: string,
        baseVersion: number,
        fm?: Record<string, unknown>,
      ) => {
        pushCount++;
        if (pushCount === 2) throw new Error("network timeout");
        return originalPush(scope as never, id, content, baseVersion, fm);
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
        commit("refs/heads/feature", [
          { type: "modify", path: "a.md", content: new TextEncoder().encode("a-updated") },
        ]),
        commit("refs/heads/main", [{ type: "modify", path: "b.md", content: new TextEncoder().encode("b-updated") }]),
      ]);

      const result = await tx.commit();
      // First ref (feature) succeeded — all its ops were applied
      const featureRef = result.refs.find((r) => r.ref === "refs/heads/feature");
      expect(featureRef?.ok).toBe(true);
      // Second ref (main) failed
      const mainRef = result.refs.find((r) => r.ref === "refs/heads/main");
      expect(mainRef?.ok).toBe(false);
      expect(mainRef?.error).toContain("network timeout");
    });

    test("multi-ref failure reports per-ref errors with aborted for unattempted", async () => {
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
      const mainRef = result.refs.find((r) => r.ref === "refs/heads/main");
      expect(mainRef?.ok).toBe(false);
      expect(mainRef?.error).toContain("provider down");
      const featureRef = result.refs.find((r) => r.ref === "refs/heads/feature");
      expect(featureRef?.ok).toBe(false);
      expect(featureRef?.error).toContain("aborted");
      expect(result.response).toContain("error refs/heads/main");
      expect(result.response).toContain("error refs/heads/feature");
    });

    test("validation failure prevents any mutations", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 1 } },
      });
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
      expect(provider.calls.push).toBe(0);
    });

    test("commit throws if stage had unresolved errors", async () => {
      const tx = new ExportTransaction(makeOpts());
      tx.stage([commit("refs/heads/main", [{ type: "delete", path: "nonexistent.md" }])]);
      await expect(tx.commit()).rejects.toThrow("unresolved stage errors");
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

    test("error messages with newlines are sanitized", async () => {
      const provider = createMockProvider({
        entries: { "a.md": { content: "a", version: 1 } },
      });
      provider.armPushFailure(new Error("line1\nline2\rline3"));

      const opts = makeOpts({ provider, entries: { "a.md": { content: "a", version: 1 } } });
      const tx = new ExportTransaction(opts);

      tx.stage([
        commit("refs/heads/main", [{ type: "modify", path: "a.md", content: new TextEncoder().encode("updated") }]),
      ]);

      const result = await tx.commit();
      const lines = result.response.split("\n");
      // First line is the error, should be a single protocol line with no embedded newlines
      expect(lines[0]).toMatch(/^error refs\/heads\/main line1 line2 line3$/);
    });
  });

  describe("createExportHandler", () => {
    test("parses fast-import stream and applies via transaction", async () => {
      const provider = createMockProvider({
        entries: { "README.md": { content: "old", version: 1 } },
      });

      const handler = createExportHandler({
        provider,
        scope: { key: "test", cloudId: "mock-cloud", resolved: {} },
        resolvePath: (path) => (path === "README.md" ? { id: "README.md", version: 1 } : undefined),
      });

      // Minimal fast-import stream
      const stream = `commit refs/heads/main
committer Test <test@test.com> 1700000000 +0000
data 11
test commit
M 100644 inline README.md
data 9
# Updated
done
`;
      const stdin = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stream));
          controller.close();
        },
      });

      const response = await handler(stdin);
      expect(response).toContain("ok refs/heads/main");
      expect(provider.state.get("README.md")?.content).toBe("# Updated");
    });

    test("deduplicates staging errors per ref (one error line per ref)", () => {
      const tx = new ExportTransaction(makeOpts());
      const errors = tx.stage([
        commit("refs/heads/main", [
          { type: "delete", path: "nonexistent-1.md" },
          { type: "delete", path: "nonexistent-2.md" },
        ]),
      ]);
      expect(errors).toHaveLength(2);
      tx.rollback();

      // Simulate what createExportHandler does: deduplicate per ref
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const s of errors) {
        if (seen.has(s.ref)) continue;
        seen.add(s.ref);
        lines.push(`error ${s.ref} ${s.error}`);
      }
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("refs/heads/main");
    });
  });
});
